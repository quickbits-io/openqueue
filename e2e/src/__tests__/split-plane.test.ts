import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClient, type OpenQueueClient } from '@openqueue/client';
import postgres from 'postgres';
import { type ControlPlane, startControlPlane } from '../control-plane';
import { DATABASE_URL, PG_SCHEMA } from '../env';
import { startTestWorker, type TestWorker } from '../harness';

/**
 * Two-plane deployment over one Postgres database: an execution worker (port B —
 * migrates, runs consumers) and a producer-side control plane (port A — no
 * consumers, never migrates), sharing a namespace + token. The client talks ONLY
 * to A: work triggered/scheduled on A executes on B, and A observes the runs.
 *
 * Gated behind `E2E_SPLIT` (set only by the `e2e:split` script) so the default
 * `e2e` / `e2e:pg` runs — which discover every `*.test.ts` — leave it untouched;
 * it boots a Postgres world and drops the schema, which those modes do not want.
 */
const RUN_SPLIT = process.env.E2E_SPLIT === '1';
const namespace = `split-${randomUUID()}`;
const token = `tok-${randomUUID()}`;
const pollFast = { pollIntervalMs: 50, maxAttempts: 400 };

async function dropSchema(): Promise<void> {
  const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop schema if exists "${PG_SCHEMA}" cascade`);
  } finally {
    await sql.end();
  }
}

describe.skipIf(!RUN_SPLIT)('two-plane deployment', () => {
  let worker: TestWorker; // port B — execution plane
  let control: ControlPlane; // port A — control plane
  let client: OpenQueueClient; // points ONLY at A

  afterAll(async () => {
    await control?.close();
    await worker?.close();
  });

  test('first-deploy ordering: the control plane over an unmigrated schema fails closed, then boots once the worker migrates', async () => {
    await dropSchema();

    // Boot A first — no worker has migrated the schema, so the never-migrate
    // gate throws instead of applying DDL from an edge/producer surface.
    await expect(
      startControlPlane({ url: DATABASE_URL, namespace, token }),
    ).rejects.toThrow(/never applies DDL/);

    // Boot B — the execution worker self-migrates (world migrations: 'auto').
    worker = await startTestWorker({ namespace, token });

    // Boot A again — the schema is migrated, so it comes up healthy.
    control = await startControlPlane({ url: DATABASE_URL, namespace, token });
    client = createClient({ host: control.url, auth: { bearer: token } });

    expect(await client.info()).toMatchObject({
      namespace,
      tasks: 1,
      queues: ['e2e'],
    });
  });

  test('catalog via A lists the tasks B published', async () => {
    const catalog = await client.catalog.read();
    expect(catalog).toContainEqual(
      expect.objectContaining({ id: 'echo', queue: 'e2e' }),
    );
  });

  test('trigger via A executes on B and completes', async () => {
    const { runId } = await client.trigger('echo', { value: 'split' });
    const run = await client.runs.poll(runId, pollFast);
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ echoed: 'split' });
  });

  test('delayed trigger + cancel via A reads back canceled', async () => {
    const { runId } = await client.trigger(
      'echo',
      { value: 'later' },
      { delay: 60_000 },
    );
    const result = await client.runs.cancel(runId);
    expect(result.outcome).toBe('canceled');
    const run = await client.runs.retrieve(runId);
    expect(run?.status).toBe('canceled');
  });

  test('schedule CRUD + runNow via A executes on B, then deactivate', async () => {
    const created = await client.schedules.create({
      task: 'echo',
      input: { value: 'sched' },
      cron: '*/5 * * * *',
      deduplicationKey: `split-${randomUUID()}`,
    });
    expect(created.task).toBe('echo');

    const { runId } = await client.schedules.runNow(created.id);
    const run = await client.runs.poll(runId, pollFast);
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ echoed: 'sched' });

    const deactivated = await client.schedules.deactivate(created.id);
    expect(deactivated.active).toBe(false);

    expect(await client.schedules.delete(created.id)).toBe(true);
  });
});
