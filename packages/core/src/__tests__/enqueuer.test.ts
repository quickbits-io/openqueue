import { describe, expect, it } from 'vitest';
import { createEnqueuer } from '../enqueuer';
import type { QueueTransport, TransportJobSpec } from '../transport/types';
import type { QueueDrainEvent, TaskDefinition } from '../types';

function task(
  over: Partial<TaskDefinition> & { queue: string },
): TaskDefinition {
  return {
    id: 'send',
    name: 'send',
    handler: async () => undefined,
    concurrency: 1,
    attempts: 1,
    backoff: { type: 'fixed', delay: 1 },
    tags: [],
    ...over,
  };
}

function stubTransport(
  enqueue: (
    queue: string,
    spec: TransportJobSpec,
  ) => Promise<{ jobId: string }>,
): QueueTransport {
  return {
    id: 'stub',
    capabilities: {
      delay: true,
      priority: true,
      flows: true,
      deduplication: true,
      remove: true,
    },
    enqueue,
    enqueueFlow: async () => ({ jobId: 'flow' }),
    getJob: async () => undefined,
    listDelayed: async () => [],
    consume: () => ({ close: async () => undefined }),
    close: async () => undefined,
  };
}

function recordingDrain(): {
  events: QueueDrainEvent[];
  drain: { handle: (event: QueueDrainEvent) => Promise<void> };
} {
  const events: QueueDrainEvent[] = [];
  return {
    events,
    drain: {
      handle: async (event) => {
        events.push(event);
      },
    },
  };
}

describe('createEnqueuer', () => {
  it('emits the enqueue hook, then the fail hook, then rethrows the original error when transport.enqueue throws', async () => {
    const { events, drain } = recordingDrain();
    const boom = new Error('transport unavailable');
    const enqueuer = createEnqueuer({
      transport: stubTransport(async () => {
        throw boom;
      }),
      drain,
    });

    const thrown = await enqueuer
      .enqueue(task({ queue: 'q' }), { hi: true }, { runId: 'r1' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    // The ORIGINAL error propagates (not a wrapped/replaced one).
    expect(thrown).toBe(boom);

    // Pinned ordering: the enqueue hook fires before the transport call, then
    // the failure hook fires after it throws — enqueue precedes fail.
    expect(events.map((event) => event.type)).toEqual(['enqueue', 'fail']);

    const fail = events[1];
    expect(fail?.type).toBe('fail');
    if (fail?.type === 'fail') {
      expect(fail.run.id).toBe('r1');
      expect(fail.run.status).toBe('failed');
      expect(fail.run.willRetry).toBe(false);
      expect(fail.run.error?.retryable).toBe(false);
      expect(fail.run.finishedAt).toBeInstanceOf(Date);
    }
  });

  it('emits only the enqueue hook (no fail hook) on a successful enqueue', async () => {
    const { events, drain } = recordingDrain();
    const enqueuer = createEnqueuer({
      transport: stubTransport(async () => ({ jobId: 'job-1' })),
      drain,
    });

    const result = await enqueuer.enqueue(
      task({ queue: 'q' }),
      { hi: true },
      { runId: 'r1' },
    );

    expect(result).toMatchObject({
      id: 'r1',
      runId: 'r1',
      jobId: 'job-1',
      transportJobId: 'job-1',
    });
    expect(events.map((event) => event.type)).toEqual(['enqueue']);
  });
});
