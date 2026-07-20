import type { ActiveTransportJob, ConsumeOptions } from '@openqueue/core/world';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresTransport } from '../transport';
import { hasDb, resetSchema, testClient, uniqueNamespace } from './test-db';

describe.runIf(hasDb)('world-postgres stall recovery', () => {
  const sql = testClient();
  const namespace = uniqueNamespace('stall');

  beforeAll(async () => {
    await resetSchema(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  const baseOptions = (over: Partial<ConsumeOptions>): ConsumeOptions => ({
    isFinal: () => false,
    process: async () => undefined,
    onCompleted: () => undefined,
    onFailed: () => undefined,
    onError: (err) => {
      throw err;
    },
    ...over,
  });

  it("recovers a dead worker's expired claim for a second consumer", async () => {
    const queue = 'recover';
    // A dead worker's row: active, its visibility window already elapsed.
    await sql`
      insert into "openqueue"."jobs"
        (namespace, queue, id, name, data, state, claimed_until, run_at)
      values (${namespace}, ${queue}, 'stuck', 'work', '{}'::jsonb, 'active',
              now() - interval '5 seconds', now())
    `;

    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 50 },
      stall: { visibilityMs: 300, heartbeatMs: 100_000 },
    });
    const completed: string[] = [];
    const consumer = transport.consume(
      queue,
      baseOptions({
        process: async () => 'ok',
        onCompleted: (job) => {
          completed.push(job.id ?? '');
        },
      }),
    );

    await waitFor(() => completed.length === 1);
    expect(completed).toEqual(['stuck']);
    await consumer.close();
    await transport.close();
  });

  it('fails a job (final) once it exceeds maxStalledCount', async () => {
    const queue = 'exceeded';
    // Already recovered once (stalled_count = 1); with maxStalledCount 1 the next
    // stall pass gives up on it.
    await sql`
      insert into "openqueue"."jobs"
        (namespace, queue, id, name, data, state, claimed_until, run_at, stalled_count)
      values (${namespace}, ${queue}, 'gone', 'work', '{}'::jsonb, 'active',
              now() - interval '5 seconds', now(), 1)
    `;

    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 50 },
      stall: { visibilityMs: 300, heartbeatMs: 100_000 },
    });
    const failures: { job: ActiveTransportJob | undefined; final: boolean }[] =
      [];
    const consumer = transport.consume(
      queue,
      baseOptions({
        maxStalledCount: 1,
        onFailed: (job, _err, { final }) => {
          failures.push({ job, final });
        },
      }),
    );

    await waitFor(() => failures.length === 1);
    expect(failures[0]?.final).toBe(true);
    expect(failures[0]?.job?.name).toBe('work');
    const rows = await sql`
      select 1 from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue} and id = 'gone'
    `;
    expect(rows).toHaveLength(0);
    await consumer.close();
    await transport.close();
  });

  it('stamps a stalled-out failure with a finish time and duration so its run is not left unfinished', async () => {
    const queue = 'stalled-finish';
    // Already stalled once; its last claim (processed_on) is 10s ago. With
    // maxStalledCount 1 the next pass fails it — the synthetic job must carry a
    // finishedOn (and the last-claim processedOn) so the terminal run persists a
    // finish time and duration rather than looking unfinished.
    await sql`
      insert into "openqueue"."jobs"
        (namespace, queue, id, name, data, state, claimed_until, run_at,
         stalled_count, processed_on)
      values (${namespace}, ${queue}, 'finish', 'work', '{}'::jsonb, 'active',
              now() - interval '5 seconds', now(), 1, now() - interval '10 seconds')
    `;

    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 50 },
      stall: { visibilityMs: 300, heartbeatMs: 100_000 },
    });
    const failures: (ActiveTransportJob | undefined)[] = [];
    const consumer = transport.consume(
      queue,
      baseOptions({
        maxStalledCount: 1,
        onFailed: (job) => {
          failures.push(job);
        },
      }),
    );

    await waitFor(() => failures.length === 1);
    const job = failures[0];
    expect(Number.isFinite(job?.finishedOn ?? Number.NaN)).toBe(true);
    expect(job?.finishedOn ?? 0).toBeGreaterThan(0);
    // The last-claim processed_on flows through so buildSnapshot can derive a
    // duration; finish must not precede start.
    expect(Number.isFinite(job?.processedOn ?? Number.NaN)).toBe(true);
    expect(job?.finishedOn ?? 0).toBeGreaterThanOrEqual(job?.processedOn ?? 0);

    await consumer.close();
    await transport.close();
  });

  it('keeps heartbeating an in-flight job through a graceful close so a peer worker cannot steal it', async () => {
    const queue = 'drain-heartbeat';
    // Visibility far shorter than the job: without a heartbeat during the drain,
    // the claim would expire mid-close and a peer's stall pass could reclaim it.
    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 25 },
      stall: { visibilityMs: 200, heartbeatMs: 60 },
    });

    let processed = 0;
    let completed = 0;
    const errors: unknown[] = [];
    let onStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      onStarted = resolve;
    });
    const options = baseOptions({
      concurrency: 1,
      maxStalledCount: 5,
      process: async () => {
        processed += 1;
        onStarted();
        await sleep(600);
        return 'ok';
      },
      onCompleted: () => {
        completed += 1;
      },
      onError: (err) => errors.push(err),
    });

    // Only A is consuming when the job lands, so A is guaranteed to claim it.
    const a = transport.consume(queue, options);
    await transport.enqueue(queue, { id: 'long', name: 'work', data: {} });
    await started;
    // B starts polling the same queue while A's job is in flight, then A closes.
    const b = transport.consume(queue, options);
    await a.close();

    await waitFor(() => completed >= 1, 4000);
    await sleep(300);

    expect(errors).toEqual([]);
    expect(processed).toBe(1);
    expect(completed).toBe(1);
    const rows = await sql`
      select 1 from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue} and id = 'long'
    `;
    expect(rows).toHaveLength(0);

    await b.close();
    await transport.close();
  });

  it('keeps a long job alive via heartbeat so it is not stolen', async () => {
    const queue = 'heartbeat';
    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 50 },
      stall: { visibilityMs: 300, heartbeatMs: 100 },
    });

    let processed = 0;
    let completed = 0;
    let failed = 0;
    const options = baseOptions({
      // Runs well past the 300ms visibility window; heartbeat must protect it.
      process: async () => {
        processed += 1;
        await sleep(900);
        return 'ok';
      },
      onCompleted: () => {
        completed += 1;
      },
      onFailed: () => {
        failed += 1;
      },
    });
    const a = transport.consume(queue, options);
    const b = transport.consume(queue, options);

    await transport.enqueue(queue, { id: 'long', name: 'work', data: {} });
    await waitFor(() => completed === 1, 4000);
    await sleep(200);

    expect(processed).toBe(1);
    expect(completed).toBe(1);
    expect(failed).toBe(0);
    await a.close();
    await b.close();
    await transport.close();
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  timeout = 5000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error('stall: waitFor timed out');
    }
    await sleep(25);
  }
}
