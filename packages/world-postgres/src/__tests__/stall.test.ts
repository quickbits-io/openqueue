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
