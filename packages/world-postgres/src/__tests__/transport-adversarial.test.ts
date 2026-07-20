import { postgresAdapter } from '@openqueue/core/drizzle';
import type { ConsumeOptions } from '@openqueue/core/world';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queueSchema } from '../schema';
import { createPostgresTransport } from '../transport';
import { hasDb, resetSchema, testClient, uniqueNamespace } from './test-db';

// Adversarial probes for the SKIP LOCKED delivery transport: real-concurrency
// exactly-once, the jsonb/backoff round-trip (deviation 1), the timestamp
// coercion after the drizzle store mutates the shared parser (deviation 2), the
// settlement-vs-stall boundary, and the remove-vs-claim race.
describe.runIf(hasDb)('world-postgres transport (adversarial)', () => {
  const sql = testClient();

  beforeAll(async () => {
    await resetSchema(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  const baseOptions = (over: Partial<ConsumeOptions>): ConsumeOptions => ({
    isFinal: (err) => err instanceof Error && err.message === 'final',
    process: async () => undefined,
    onCompleted: () => undefined,
    onFailed: () => undefined,
    onError: () => undefined,
    ...over,
  });

  it('delivers 20 jobs across two consumers exactly once (SKIP LOCKED, no double-delivery)', async () => {
    const queue = 'concurrency';
    const namespace = uniqueNamespace('conc');
    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 25 },
    });
    const processed: string[] = [];
    const errors: unknown[] = [];
    const options = baseOptions({
      concurrency: 5,
      process: async (job) => {
        processed.push(job.id ?? '');
        await sleep(5);
      },
      onError: (err) => errors.push(err),
    });
    const a = transport.consume(queue, options);
    const b = transport.consume(queue, options);

    const ids = Array.from({ length: 20 }, (_, i) => `c${i}`);
    for (const id of ids) {
      await transport.enqueue(queue, { id, name: 'work', data: { i: id } });
    }

    await waitFor(() => processed.length >= 20, 10_000);
    // Give any erroneous extra deliveries a chance to land before asserting.
    await sleep(300);

    expect(errors).toEqual([]);
    // Every id seen exactly once: no row claimed by both consumers.
    expect([...processed].sort()).toEqual([...ids].sort());
    expect(new Set(processed).size).toBe(20);
    const remaining = await sql`
      select count(*)::int as n from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue}
    `;
    expect(remaining[0]?.n).toBe(0);

    await a.close();
    await b.close();
    await transport.close();
  });

  it('round-trips nested unicode/emoji jsonb and honors a numeric backoff on retry (no NaN delay)', async () => {
    const queue = 'jsonb';
    const namespace = uniqueNamespace('jsonb');
    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 25 },
    });
    const payload = {
      greeting: '你好 🌍',
      nested: {
        arr: [1, 'two', null, true, 3.14],
        emoji: '🎉🔥🧨',
        quote: 'a "quoted" \\ value with — em dash',
        unicode: 'ümläut ☃ řžý',
        empty: '',
      },
    };

    // Direct storage round-trip: the ::text::jsonb cast must not double-encode the
    // nested payload, and a numeric backoff must land as a jsonb number, not a
    // quoted string (which would make retryDelay() compute NaN). A separate queue
    // keeps this unconsumed probe row out of the retry consumer's path.
    const storeQueue = 'jsonb-store';
    await transport.enqueue(storeQueue, {
      id: 'store',
      name: 'work',
      data: payload,
      backoff: 300,
    });
    const [stored] = await sql<{ data: unknown; backoff: unknown }[]>`
      select data, backoff from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${storeQueue} and id = 'store'
    `;
    expect(stored?.data).toEqual(payload);
    expect(stored?.backoff).toBe(300);

    // Behavioral: a retryable failure must re-claim after ~backoff ms. A
    // double-encoded backoff would read back as NaN → no retry → this times out.
    const seen: unknown[] = [];
    const attemptAt: number[] = [];
    const errors: unknown[] = [];
    let done = false;
    const consumer = transport.consume(
      queue,
      baseOptions({
        process: async (job) => {
          attemptAt.push(Date.now());
          seen.push(job.data);
          if (job.attemptsMade === 0) throw new Error('retry');
          return 'ok';
        },
        onCompleted: () => {
          done = true;
        },
        onError: (err) => errors.push(err),
      }),
    );
    await transport.enqueue(queue, {
      id: 'retry',
      name: 'work',
      data: payload,
      attempts: 2,
      backoff: 300,
    });

    await waitFor(() => done, 8000);
    expect(errors).toEqual([]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(payload);
    expect(seen[1]).toEqual(payload);
    // The gap proves the numeric backoff was applied (not NaN, not 0).
    expect((attemptAt[1] ?? 0) - (attemptAt[0] ?? 0)).toBeGreaterThanOrEqual(
      250,
    );

    await consumer.close();
    await transport.close();
  });

  it('refreshes processed_on on each retry claim so a retry reports its own start, not the first attempt’s', async () => {
    const queue = 'retry-processed';
    const namespace = uniqueNamespace('retryproc');
    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 25 },
    });
    const processedOns: number[] = [];
    const errors: unknown[] = [];
    let done = false;
    const consumer = transport.consume(
      queue,
      baseOptions({
        process: async (job) => {
          processedOns.push(job.processedOn ?? Number.NaN);
          if (job.attemptsMade === 0) throw new Error('retry');
          return 'ok';
        },
        onCompleted: () => {
          done = true;
        },
        onError: (err) => errors.push(err),
      }),
    );
    // A ~300ms backoff separates the two attempts; a stale processed_on (carried
    // from attempt 1) would make both claims report the same start time.
    await transport.enqueue(queue, {
      id: 'retry',
      name: 'work',
      data: {},
      attempts: 2,
      backoff: 300,
    });

    await waitFor(() => done, 8000);
    expect(errors).toEqual([]);
    expect(processedOns).toHaveLength(2);
    expect(Number.isFinite(processedOns[0] ?? Number.NaN)).toBe(true);
    expect(Number.isFinite(processedOns[1] ?? Number.NaN)).toBe(true);
    // The retry claim's processed_on advanced by roughly the backoff — proof it
    // was set to now() on the second claim, not preserved from the first.
    expect(
      (processedOns[1] ?? 0) - (processedOns[0] ?? 0),
    ).toBeGreaterThanOrEqual(250);

    await consumer.close();
    await transport.close();
  });

  it('keeps transport timestamps finite after the drizzle store disables the postgres.js parser', async () => {
    // Isolated client: constructing the store mutates the shared client's
    // timestamptz parser (returns strings), so give this probe its own client to
    // avoid leaking that mutation into sibling tests.
    const tsSql = testClient();
    const namespace = uniqueNamespace('ts');
    try {
      // A real store, constructed and queried before the transport runs.
      const store = postgresAdapter({
        db: drizzle(tsSql),
        schema: queueSchema,
      });
      await store.read();
      const [nowRow] = await tsSql<{ ts: unknown }[]>`select now() as ts`;
      // Precondition: the store really did disable the native timestamp parser.
      expect(typeof nowRow?.ts).toBe('string');

      const transport = createPostgresTransport({
        sql: tsSql,
        namespace,
        poll: { intervalMs: 25 },
        stall: { visibilityMs: 200, heartbeatMs: 1_000_000 },
      });

      // getJob + listDelayed read the delivery row on the mutated client.
      const delayedQueue = 'ts-delayed';
      await transport.enqueue(delayedQueue, {
        id: 'delayed',
        name: 'work',
        data: {},
        delay: 500,
      });
      const delayed = await transport.listDelayed(delayedQueue);
      expect(delayed.some((h) => h.name === 'work')).toBe(true);
      const handle = await transport.getJob(delayedQueue, 'delayed');
      expect(handle?.name).toBe('work');

      // process() timestamps derive from created_at/processed_on, which now
      // arrive as strings — toDate() must still yield finite epoch ms.
      const runQueue = 'ts-run';
      const stamps: { timestamp: number; processedOn: number }[] = [];
      const errors: unknown[] = [];
      const runner = transport.consume(
        runQueue,
        baseOptions({
          process: async () => 'ok',
          onCompleted: (job) => {
            stamps.push({
              timestamp: job.timestamp,
              processedOn: job.processedOn ?? Number.NaN,
            });
          },
          onError: (err) => errors.push(err),
        }),
      );
      await transport.enqueue(runQueue, { id: 'run', name: 'work', data: {} });
      await waitFor(() => stamps.length === 1, 5000);
      expect(errors).toEqual([]);
      expect(Number.isFinite(stamps[0]?.timestamp ?? Number.NaN)).toBe(true);
      expect(Number.isFinite(stamps[0]?.processedOn ?? Number.NaN)).toBe(true);
      expect(stamps[0]?.timestamp ?? 0).toBeGreaterThan(0);
      await runner.close();

      // A stall-recovery pass on the mutated client: a long-expired active row
      // that already hit maxStalledCount is failed (final) without a parser blowup.
      const stallQueue = 'ts-stall';
      await tsSql`
        insert into "openqueue"."jobs"
          (namespace, queue, id, name, data, state, claimed_until, run_at, stalled_count)
        values (${namespace}, ${stallQueue}, 'stalled', 'work', '{}'::jsonb,
                'active', now() - interval '5 seconds', now(), 1)
      `;
      const failures: { final: boolean; timestamp: number }[] = [];
      const stallErrors: unknown[] = [];
      const stallConsumer = transport.consume(
        stallQueue,
        baseOptions({
          maxStalledCount: 1,
          onFailed: (job, _err, { final }) => {
            failures.push({ final, timestamp: job?.timestamp ?? Number.NaN });
          },
          onError: (err) => stallErrors.push(err),
        }),
      );
      await waitFor(() => failures.length === 1, 5000);
      expect(stallErrors).toEqual([]);
      expect(failures[0]?.final).toBe(true);
      expect(Number.isFinite(failures[0]?.timestamp ?? Number.NaN)).toBe(true);
      await stallConsumer.close();

      await transport.close();
    } finally {
      await tsSql.end();
    }
  });

  it('settles exactly once at the claim-expiry boundary (no double onCompleted/onFailed)', async () => {
    const queue = 'boundary';
    const namespace = uniqueNamespace('boundary');
    // Heartbeat off (far in the future), process outlives the visibility window:
    // the stall pass recovers the row to waiting while the original attempt is
    // still in flight. inFlight accounting must keep concurrency=1 from
    // re-claiming, so settlement still fires exactly one terminal callback.
    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 25 },
      stall: { visibilityMs: 150, heartbeatMs: 1_000_000 },
    });
    let processCount = 0;
    let completed = 0;
    let failed = 0;
    const errors: unknown[] = [];
    const consumer = transport.consume(
      queue,
      baseOptions({
        concurrency: 1,
        maxStalledCount: 5,
        process: async () => {
          processCount += 1;
          await sleep(320);
          return 'ok';
        },
        onCompleted: () => {
          completed += 1;
        },
        onFailed: () => {
          failed += 1;
        },
        onError: (err) => errors.push(err),
      }),
    );

    await transport.enqueue(queue, { id: 'edge', name: 'work', data: {} });
    await waitFor(() => completed >= 1, 5000);
    await sleep(400);

    expect(errors).toEqual([]);
    expect(processCount).toBe(1);
    expect(completed).toBe(1);
    expect(failed).toBe(0);
    const rows = await sql`
      select 1 from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue} and id = 'edge'
    `;
    expect(rows).toHaveLength(0);

    await consumer.close();
    await transport.close();
  });

  it('fences a lost-lease settlement so a reclaiming peer is not clobbered (no double terminal callback)', async () => {
    const queue = 'fence';
    const namespace = uniqueNamespace('fence');
    // Heartbeat off, visibility short: worker A's claim expires mid-process and a
    // peer B reclaims and settles the same id. A's late (stale) settlement must be
    // fenced by its claim token — it must not delete B's active row nor fire a
    // second terminal callback.
    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 25 },
      stall: { visibilityMs: 200, heartbeatMs: 1_000_000 },
    });
    let processStarts = 0;
    let completions = 0;
    let aProcessDone = false;
    const errors: unknown[] = [];
    let resolveStart = (): void => {};
    const started = new Promise<void>((resolve) => {
      resolveStart = resolve;
    });

    // A: claims first, loses its lease (process outlives visibility), completes late.
    const a = transport.consume(
      queue,
      baseOptions({
        concurrency: 1,
        maxStalledCount: 5,
        process: async () => {
          processStarts += 1;
          resolveStart();
          await sleep(350);
          aProcessDone = true;
          return 'ok';
        },
        onCompleted: () => {
          completions += 1;
        },
        onError: (err) => errors.push(err),
      }),
    );
    await transport.enqueue(queue, { id: 'lease', name: 'work', data: {} });
    await started;

    // B: joins while A holds the job, reclaims after A's lease expires, settles fast.
    const b = transport.consume(
      queue,
      baseOptions({
        concurrency: 1,
        maxStalledCount: 5,
        process: async () => {
          processStarts += 1;
          await sleep(120);
          return 'ok';
        },
        onCompleted: () => {
          completions += 1;
        },
        onError: (err) => errors.push(err),
      }),
    );

    await waitFor(() => aProcessDone && processStarts >= 2, 8000);
    // Let A's fenced settlement land after B has already settled.
    await sleep(400);

    expect(errors).toEqual([]);
    // Both workers executed the job (at-least-once under stall recovery)...
    expect(processStarts).toBeGreaterThanOrEqual(2);
    // ...but only the reclaiming peer's settlement counts: the stale one is fenced.
    expect(completions).toBe(1);
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue} and id = 'lease'
    `;
    expect(rows[0]?.n).toBe(0);

    await a.close();
    await b.close();
    await transport.close();
  });

  it('never both removes and delivers a job racing remove() against a claim pass', async () => {
    const queue = 'remove-race';
    const namespace = uniqueNamespace('rmrace');
    const transport = createPostgresTransport({
      sql,
      namespace,
      poll: { intervalMs: 5 },
    });
    const processed: string[] = [];
    const errors: unknown[] = [];
    const consumer = transport.consume(
      queue,
      baseOptions({
        concurrency: 4,
        process: async (job) => {
          processed.push(job.id ?? '');
          await sleep(5);
        },
        onError: (err) => errors.push(err),
      }),
    );

    const ids = Array.from({ length: 25 }, (_, i) => `r${i}`);
    const removedOk: string[] = [];
    for (const id of ids) {
      await transport.enqueue(queue, { id, name: 'work', data: {} });
      // Race the remove against the running claim loop.
      const handle = await transport.getJob(queue, id);
      await handle
        ?.remove()
        .then(() => {
          removedOk.push(id);
        })
        .catch(() => undefined);
    }

    // Let the consumer drain anything that was claimed rather than removed.
    await sleep(600);

    expect(errors).toEqual([]);
    // No id is ever delivered twice.
    expect(new Set(processed).size).toBe(processed.length);
    // Every id reached a single terminal outcome and left no waiting row behind.
    const leftover = await sql<{ n: number }[]>`
      select count(*)::int as n from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue}
    `;
    expect(leftover[0]?.n).toBe(0);
    // A delivered id may also see remove() resolve as a no-op (row already gone),
    // but a job can never be both processed and still-waiting.
    for (const id of ids) {
      const delivered = processed.includes(id);
      expect(delivered || removedOk.includes(id)).toBe(true);
    }

    await consumer.close();
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
      throw new Error('adversarial: waitFor timed out');
    }
    await sleep(25);
  }
}
