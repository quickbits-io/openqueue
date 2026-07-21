import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type {
  ActiveTransportJob,
  ConsumeOptions,
  QueueTransport,
  TransportConsumer,
  TransportJobSpec,
} from './types';

/**
 * Behavioural contract every {@link QueueTransport} must satisfy, expressed as a
 * reusable vitest suite. Scenarios gate themselves on the transport's declared
 * capabilities via `it.skipIf`, so a transport that turns a flag off simply
 * skips the matching cases instead of failing them.
 *
 * The suite pins the semantics core relies on today (attemptsMade convention,
 * per-attempt failure callbacks, updateData persistence, delayed visibility,
 * dedup, flow ordering) so any future transport is held to the same behaviour.
 */
export interface TransportConformanceConfig {
  name: string;
  /** Returns a transport bound to fresh, isolated state. */
  create: () => QueueTransport;
  timing?: {
    /** Max wait for a delivery/completion to be observed. Default 3000ms. */
    settleMs?: number;
    /** Delay used by the delayed-delivery scenarios. Default 800ms. */
    delayMs?: number;
  };
}

export function describeTransportConformance(
  config: TransportConformanceConfig,
): void {
  const settleMs = config.timing?.settleMs ?? 3000;
  const delayMs = config.timing?.delayMs ?? 800;

  describe(`transport conformance — ${config.name}`, () => {
    const transport = config.create();
    const caps = transport.capabilities;
    const active: TransportConsumer[] = [];
    let counter = 0;

    const nextQueue = () => `conf-${counter++}`;
    const track = (consumer: TransportConsumer): TransportConsumer => {
      active.push(consumer);
      return consumer;
    };

    afterEach(async () => {
      await Promise.all(
        active.splice(0).map((c) => c.close().catch(() => undefined)),
      );
    });
    afterAll(async () => {
      await transport.close();
    });

    const consume = (queue: string, options: Partial<ConsumeOptions>) =>
      track(
        transport.consume(queue, {
          isFinal: (err) => err instanceof Error && err.message === 'final',
          process: async () => undefined,
          onCompleted: () => undefined,
          onFailed: () => undefined,
          onError: () => undefined,
          ...options,
        }),
      );

    async function waitFor(
      predicate: () => boolean,
      timeout = settleMs,
    ): Promise<void> {
      const start = Date.now();
      while (!predicate()) {
        if (Date.now() - start > timeout) {
          throw new Error('conformance: waitFor timed out');
        }
        await sleep(25);
      }
    }

    it('delivers an enqueued job, reports completion, and echoes the id', async () => {
      const queue = nextQueue();
      const processed: ActiveTransportJob[] = [];
      const completed: ActiveTransportJob[] = [];
      consume(queue, {
        process: async (job) => {
          processed.push(job);
          return { echo: job.name };
        },
        onCompleted: (job) => {
          completed.push(job);
        },
      });

      const { jobId } = await transport.enqueue(
        queue,
        spec({ id: 'job-1', name: 'greet', data: { a: 1 } }),
      );
      expect(jobId).toBe('job-1');

      await waitFor(() => completed.length === 1);
      expect(processed).toHaveLength(1);
      expect(processed[0]?.name).toBe('greet');
      expect(processed[0]?.data).toEqual({ a: 1 });
      expect(completed[0]?.id).toBe('job-1');
      expect(completed[0]?.returnvalue).toEqual({ echo: 'greet' });
    });

    it('reports attemptsMade as 0 in process() and 1 in the callback', async () => {
      const queue = nextQueue();
      const inProcess: number[] = [];
      const inCallback: number[] = [];
      consume(queue, {
        process: async (job) => {
          inProcess.push(job.attemptsMade);
          throw new Error('retry');
        },
        onFailed: (job) => {
          if (job) inCallback.push(job.attemptsMade);
        },
      });

      await transport.enqueue(queue, spec({ id: 'a', name: 'x', attempts: 1 }));
      await waitFor(() => inCallback.length === 1);
      expect(inProcess[0]).toBe(0);
      expect(inCallback[0]).toBe(1);
    });

    it('retries a retryable failure, then stops on a final failure', async () => {
      const queue = nextQueue();
      const attempts: number[] = [];
      const failures: boolean[] = [];
      consume(queue, {
        process: async (job) => {
          attempts.push(job.attemptsMade);
          throw job.attemptsMade === 0
            ? new Error('retry')
            : new Error('final');
        },
        onFailed: (job, _err, { final }) => {
          if (job) failures.push(final);
        },
      });

      await transport.enqueue(
        queue,
        spec({
          id: 'r',
          name: 'x',
          attempts: 3,
          backoff: { type: 'fixed', delay: 10 },
        }),
      );
      await waitFor(() => failures.length === 2);
      await sleep(200);
      expect(attempts).toEqual([0, 1]);
      expect(failures).toEqual([false, true]);
    });

    it('does not retry when the first failure is final', async () => {
      const queue = nextQueue();
      let processCount = 0;
      const failures: boolean[] = [];
      consume(queue, {
        process: async () => {
          processCount++;
          throw new Error('final');
        },
        onFailed: (_job, _err, { final }) => {
          failures.push(final);
        },
      });

      await transport.enqueue(queue, spec({ id: 'f', name: 'x', attempts: 5 }));
      await waitFor(() => failures.length === 1);
      await sleep(200);
      expect(processCount).toBe(1);
      expect(failures).toEqual([true]);
    });

    it('persists updateData across retries', async () => {
      const queue = nextQueue();
      const seen: unknown[] = [];
      consume(queue, {
        process: async (job) => {
          seen.push(job.data);
          if (job.attemptsMade === 0) {
            await job.updateData({
              ...(job.data as Record<string, unknown>),
              marker: 'set',
            });
            throw new Error('retry');
          }
        },
      });

      await transport.enqueue(
        queue,
        spec({
          id: 'u',
          name: 'x',
          data: { base: true },
          attempts: 2,
          backoff: { type: 'fixed', delay: 10 },
        }),
      );
      await waitFor(() => seen.length === 2);
      expect(seen[0]).toEqual({ base: true });
      expect(seen[1]).toMatchObject({ base: true, marker: 'set' });
    });

    it('accepts updateProgress during processing', async () => {
      const queue = nextQueue();
      const completed: ActiveTransportJob[] = [];
      consume(queue, {
        process: async (job) => {
          await job.updateProgress({ pct: 42 });
          return 'ok';
        },
        onCompleted: (job) => {
          completed.push(job);
        },
      });

      await transport.enqueue(queue, spec({ id: 'p', name: 'x' }));
      await waitFor(() => completed.length === 1);
      expect(completed[0]?.returnvalue).toBe('ok');
    });

    it.skipIf(!caps.delay)(
      'holds delayed jobs and exposes them via listDelayed',
      async () => {
        const queue = nextQueue();
        const processed: string[] = [];
        consume(queue, {
          process: async (job) => {
            processed.push(job.id ?? '');
          },
        });

        const enqueuedAt = Date.now();
        await transport.enqueue(
          queue,
          spec({ id: 'd', name: 'x', delay: delayMs }),
        );

        await sleep(Math.min(150, delayMs / 2));
        const delayed = await transport.listDelayed(queue);
        expect(delayed.some((handle) => handle.name === 'x')).toBe(true);
        expect(processed).toHaveLength(0);

        await waitFor(() => processed.length === 1, delayMs + settleMs);
        expect(Date.now() - enqueuedAt).toBeGreaterThanOrEqual(delayMs - 100);
      },
    );

    it.skipIf(!caps.priority)(
      'drains a backlog in priority order',
      async () => {
        const queue = nextQueue();
        const order: string[] = [];
        await transport.enqueue(
          queue,
          spec({ id: 'lo', name: 'x', priority: 10 }),
        );
        await transport.enqueue(
          queue,
          spec({ id: 'hi', name: 'x', priority: 1 }),
        );
        await transport.enqueue(
          queue,
          spec({ id: 'mid', name: 'x', priority: 5 }),
        );

        consume(queue, {
          concurrency: 1,
          process: async (job) => {
            order.push(job.id ?? '');
          },
        });

        await waitFor(() => order.length === 3);
        expect(order).toEqual(['hi', 'mid', 'lo']);
      },
    );

    it.skipIf(!caps.deduplication)(
      'delivers a duplicated job id only once',
      async () => {
        const queue = nextQueue();
        const processed: string[] = [];
        await transport.enqueue(queue, spec({ id: 'dup', name: 'x' }));
        await transport.enqueue(queue, spec({ id: 'dup', name: 'x' }));

        consume(queue, {
          process: async (job) => {
            processed.push(job.id ?? '');
          },
        });

        await waitFor(() => processed.length >= 1);
        await sleep(200);
        expect(processed).toEqual(['dup']);
      },
    );

    it.skipIf(!caps.remove)(
      'never delivers a job removed before processing',
      async () => {
        const queue = nextQueue();
        const processed: string[] = [];
        await transport.enqueue(
          queue,
          spec({ id: 'rm', name: 'x', delay: delayMs }),
        );

        const handle = await transport.getJob(queue, 'rm');
        expect(handle).toBeDefined();
        await handle?.remove();
        expect(await transport.getJob(queue, 'rm')).toBeUndefined();

        consume(queue, {
          process: async (job) => {
            processed.push(job.id ?? '');
          },
        });

        await sleep(delayMs + 300);
        expect(processed).toHaveLength(0);
      },
    );

    it.skipIf(!caps.remove)('rejects removal of an active job', async () => {
      const queue = nextQueue();
      const started = deferred<void>();
      const release = deferred<void>();
      consume(queue, {
        process: async () => {
          started.resolve();
          await release.promise;
        },
      });

      await transport.enqueue(queue, spec({ id: 'act', name: 'x' }));
      await started.promise;

      const handle = await transport.getJob(queue, 'act');
      expect(handle).toBeDefined();
      if (handle) await expect(handle.remove()).rejects.toThrow();
      release.resolve();
    });

    it.skipIf(!caps.flows)(
      'processes flow children before the parent',
      async () => {
        const parentQueue = nextQueue();
        const childQueue = nextQueue();
        const order: string[] = [];
        consume(parentQueue, {
          process: async (job) => {
            order.push(job.name);
          },
        });
        consume(childQueue, {
          process: async (job) => {
            order.push(job.name);
          },
        });

        await transport.enqueueFlow({
          queue: parentQueue,
          spec: spec({ id: 'parent', name: 'parent' }),
          children: [
            { queue: childQueue, spec: spec({ id: 'child', name: 'child' }) },
          ],
        });

        await waitFor(() => order.length === 2);
        expect(order).toEqual(['child', 'parent']);
      },
    );

    it('closes a consumer gracefully mid-backlog', async () => {
      const queue = nextQueue();
      let processed = 0;
      const consumer = consume(queue, {
        concurrency: 1,
        process: async () => {
          processed++;
          await sleep(30);
        },
      });

      for (let i = 0; i < 6; i++) {
        await transport.enqueue(queue, spec({ id: `b${i}`, name: 'x' }));
      }
      await waitFor(() => processed >= 1);
      await expect(consumer.close()).resolves.toBeUndefined();
    });
  });
}

function spec(
  over: Partial<TransportJobSpec> & { id: string; name: string },
): TransportJobSpec {
  return { data: {}, ...over };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
