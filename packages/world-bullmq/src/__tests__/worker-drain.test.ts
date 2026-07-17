import { randomUUID } from 'node:crypto';
import { NonRetryableError } from '@openqueue/core';
import type {
  QueueDrainEvent,
  QueueRunSnapshot,
  TaskDefinition,
} from '@openqueue/core/types';
import { Redis } from 'ioredis';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
// Source-relative: createWorkerConsumers is a package-private core helper (not a
// frozen export). isNonRetryable's structural `retryable === false` check keeps a
// cross-instance NonRetryableError recognized as final.
import { createWorkerConsumers } from '../../../core/src/worker';
import type { BullmqConsumer } from '../transport';
import { createBullmqTransport } from '../transport';

const url = process.env.REDIS_URL;

/**
 * End-to-end drain parity for the transport refactor: exercises the REAL BullMQ
 * retry / exhaustion / UnrecoverableError-conversion path (which the mocked
 * suites cannot reproduce) and asserts the drain fields the worker derives —
 * `attempt`, `willRetry`, `status`, and the serialized error's `retryable` —
 * match pre-refactor semantics. In particular it pins the Stage A deviation:
 * `runJob` now throws `NonRetryableError` and the transport converts it to
 * BullMQ's `UnrecoverableError`, which must still surface as a final failure
 * (`willRetry:false`, `error.retryable:false`, `error.name:'UnrecoverableError'`).
 */
describe.skipIf(!url)('worker drain parity (real redis)', () => {
  const namespace = `wdrain-${randomUUID().slice(0, 8)}`;
  const connection = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  const transport = createBullmqTransport({
    producer: connection,
    consumer: connection,
    namespace,
  });
  const consumers: BullmqConsumer[] = [];

  afterEach(async () => {
    await Promise.all(
      consumers.splice(0).map((c) => c.close().catch(() => undefined)),
    );
  });
  afterAll(async () => {
    await transport.close();
    await connection.quit().catch(() => undefined);
  });

  function task(
    over: Partial<TaskDefinition> & { queue: string },
  ): TaskDefinition {
    return {
      id: 'echo',
      name: 'echo',
      handler: async () => undefined,
      concurrency: 1,
      attempts: 1,
      backoff: { type: 'fixed', delay: 1 },
      tags: [],
      ...over,
    };
  }

  function record() {
    const events: QueueDrainEvent[] = [];
    return {
      events,
      fails: () => events.filter((e) => e.type === 'fail').map((e) => e.run),
      drain: {
        handle: async (event: QueueDrainEvent) => {
          events.push(event);
        },
      },
    };
  }

  async function enqueue(
    queue: string,
    over: { attempts: number; backoff?: TaskDefinition['backoff'] },
  ): Promise<string> {
    const runId = randomUUID();
    await transport.enqueue(queue, {
      id: runId,
      name: 'echo',
      data: {
        __input: { hi: true },
        __runId: runId,
        __meta: { tags: [] },
        __metadata: {},
      },
      attempts: over.attempts,
      backoff: over.backoff,
    });
    return runId;
  }

  async function waitFor(
    predicate: () => boolean,
    timeout = 5000,
  ): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeout) {
        throw new Error('waitFor timed out');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('completes a run and drains a complete event with the output', async () => {
    const queue = `${namespace}-ok`;
    const rec = record();
    consumers.push(
      ...createWorkerConsumers(
        [task({ queue, handler: async () => ({ echoed: true }) })],
        transport,
        { drain: rec.drain },
      ),
    );

    const runId = await enqueue(queue, { attempts: 1 });
    await waitFor(() => rec.events.some((e) => e.type === 'complete'));

    const complete = rec.events.find((e) => e.type === 'complete')?.run;
    expect(complete?.id).toBe(runId);
    expect(complete?.status).toBe('completed');
    expect(complete?.output).toEqual({ echoed: true });
    expect(complete?.willRetry).toBe(false);
  });

  it('retries a plain error, draining reattempting then failed with correct attempt/willRetry', async () => {
    const queue = `${namespace}-retry`;
    const rec = record();
    let calls = 0;
    consumers.push(
      ...createWorkerConsumers(
        [
          task({
            queue,
            handler: async () => {
              calls++;
              throw new Error('boom');
            },
          }),
        ],
        transport,
        { drain: rec.drain },
      ),
    );

    await enqueue(queue, {
      attempts: 2,
      backoff: { type: 'fixed', delay: 10 },
    });
    await waitFor(() => rec.fails().length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));

    const fails = rec.fails();
    expect(fails).toHaveLength(2);
    expect(calls).toBe(2);

    const [reattempt, failed] = fails as [QueueRunSnapshot, QueueRunSnapshot];
    expect(reattempt.status).toBe('reattempting');
    expect(reattempt.willRetry).toBe(true);
    expect(reattempt.attempt).toBe(1);
    expect(reattempt.error?.retryable).toBe(true);

    expect(failed.status).toBe('failed');
    expect(failed.willRetry).toBe(false);
    expect(failed.attempt).toBe(2);
    // Exhaustion of a plain error keeps retryable:true — willRetry is false only
    // because the attempt budget is spent, not because the error is terminal.
    expect(failed.error?.retryable).toBe(true);
    expect(failed.finishedAt).toBeInstanceOf(Date);
  });

  it('treats a NonRetryableError as final: one execution, no retry, retryable:false', async () => {
    const queue = `${namespace}-nonretryable`;
    const rec = record();
    let calls = 0;
    consumers.push(
      ...createWorkerConsumers(
        [
          task({
            queue,
            handler: async () => {
              calls++;
              throw new NonRetryableError('nope');
            },
          }),
        ],
        transport,
        { drain: rec.drain },
      ),
    );

    // attempts:5 would allow retries; a NonRetryableError must short-circuit.
    await enqueue(queue, {
      attempts: 5,
      backoff: { type: 'fixed', delay: 10 },
    });
    await waitFor(() => rec.fails().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const fails = rec.fails();
    expect(fails).toHaveLength(1);
    expect(calls).toBe(1);

    const failed = fails[0] as QueueRunSnapshot;
    expect(failed.status).toBe('failed');
    expect(failed.willRetry).toBe(false);
    expect(failed.attempt).toBe(1);
    // Transport converts NonRetryableError → UnrecoverableError; the drain sees
    // the converted error name and a non-retryable flag, matching pre-refactor.
    expect(failed.error?.retryable).toBe(false);
    expect(failed.error?.name).toBe('UnrecoverableError');
    expect(failed.error?.message).toBe('nope');
  });
});
