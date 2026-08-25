import { describe, expect, it } from 'vitest';
import { isMaxDurationExceeded } from '../errors';
import type {
  ActiveTransportJob,
  ConsumeOptions,
  TransportConsumer,
} from '../transport/types';
import type { QueueDrainEvent, TaskContext, TaskDefinition } from '../types';
import { createWorkerConsumers } from '../worker';

function task(
  over: Partial<TaskDefinition> & { handler: TaskDefinition['handler'] },
): TaskDefinition {
  return {
    id: 'slow',
    name: 'slow',
    queue: 'reports',
    concurrency: 1,
    attempts: 3,
    backoff: { type: 'fixed', delay: 0 },
    tags: [],
    ...over,
  };
}

function activeJob(): ActiveTransportJob {
  return {
    id: 'job-1',
    name: 'slow',
    queueName: 'reports',
    data: { __runId: 'run-1', __input: {}, __meta: {}, __metadata: {} },
    timestamp: Date.now(),
    attemptsMade: 0,
    returnvalue: undefined,
    opts: { attempts: 3 },
    updateData: async () => undefined,
    updateProgress: async () => undefined,
    log: async () => undefined,
  };
}

/**
 * A transport stub that exposes the registered `ConsumeOptions` and drives one
 * attempt exactly as a real transport does: `process`, then the matching
 * lifecycle callback, with `attemptsMade` going 1-based across the boundary.
 */
function stubTransport() {
  let registered: ConsumeOptions | undefined;

  const options = (): ConsumeOptions => {
    if (!registered) throw new Error('consume was not called');
    return registered;
  };

  return {
    id: 'stub',
    consume(_queue: string, opts: ConsumeOptions): TransportConsumer {
      registered = opts;
      return { close: async () => undefined };
    },
    options,
    async run(job: ActiveTransportJob): Promise<void> {
      const opts = options();
      try {
        const result = await opts.process(job);
        job.attemptsMade += 1;
        job.returnvalue = result;
        job.finishedOn = Date.now();
        await opts.onCompleted(job);
      } catch (err) {
        job.attemptsMade += 1;
        job.finishedOn = Date.now();
        await opts.onFailed(job, err, { final: opts.isFinal(err) });
      }
    },
  };
}

function recordingDrain(): { handle: (e: QueueDrainEvent) => void } & {
  events: QueueDrainEvent[];
} {
  const events: QueueDrainEvent[] = [];
  return { events, handle: (event) => events.push(event) };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('maxDuration lease derivation', () => {
  it("sizes the queue's transport lease from its longest task budget", () => {
    const transport = stubTransport();
    createWorkerConsumers(
      [
        task({
          name: 'a',
          handler: async () => undefined,
          maxDuration: 20_000,
        }),
        task({
          name: 'b',
          handler: async () => undefined,
          maxDuration: 60_000,
        }),
      ],
      transport,
    );

    // The 60s budget plus the worlds' 30s stall headroom — issue #45's queue
    // asked for exactly this 90s lock.
    expect(transport.options().lockDuration).toBe(90_000);
  });

  it('leaves the lease to the transport when no task declares a budget', () => {
    const transport = stubTransport();
    createWorkerConsumers(
      [task({ handler: async () => undefined })],
      transport,
    );

    expect(transport.options().lockDuration).toBeUndefined();
  });
});

describe('maxDuration enforcement', () => {
  it('aborts the handler and settles the run as timed_out', async () => {
    const transport = stubTransport();
    const drain = recordingDrain();
    let signal: AbortSignal | undefined;
    let late = false;
    const handler = async (ctx: TaskContext) => {
      signal = ctx.signal;
      await sleep(120);
      late = true;
      return 'too late';
    };

    createWorkerConsumers([task({ handler, maxDuration: 20 })], transport, {
      drain,
    });
    await transport.run(activeJob());

    const failure = drain.events.find((event) => event.type === 'fail');
    expect(failure?.run.status).toBe('timed_out');
    expect(signal?.aborted).toBe(true);
    // Terminal despite `attempts: 3` — a blown budget is not retried.
    expect(failure?.run.willRetry).toBe(false);
    expect(failure?.run.error?.retryable).toBe(false);

    // The handler that ignored the abort finishes after the attempt settled;
    // its result must not surface as a second, contradictory event.
    await sleep(160);
    expect(late).toBe(true);
    expect(drain.events.filter((event) => event.type === 'complete')).toEqual(
      [],
    );
    expect(drain.events.filter((event) => event.type === 'fail')).toHaveLength(
      1,
    );
  });

  it('classifies the timeout as a final, discriminable outcome', async () => {
    const transport = stubTransport();
    createWorkerConsumers(
      [task({ handler: async () => sleep(120), maxDuration: 20 })],
      transport,
    );

    const error = await transport
      .options()
      .process(activeJob())
      .catch((err: unknown) => err);

    expect(isMaxDurationExceeded(error)).toBe(true);
    expect(transport.options().isFinal(error)).toBe(true);
  });

  it('leaves a handler that finishes inside its budget alone', async () => {
    const transport = stubTransport();
    const drain = recordingDrain();
    let signal: AbortSignal | undefined;

    createWorkerConsumers(
      [
        task({
          handler: async (ctx: TaskContext) => {
            signal = ctx.signal;
            return 'ok';
          },
          maxDuration: 5_000,
        }),
      ],
      transport,
      { drain },
    );
    await transport.run(activeJob());

    const completed = drain.events.find((event) => event.type === 'complete');
    expect(completed?.run.status).toBe('completed');
    expect(drain.events.filter((event) => event.type === 'fail')).toEqual([]);
    expect(signal?.aborted).toBe(false);
  });
});
