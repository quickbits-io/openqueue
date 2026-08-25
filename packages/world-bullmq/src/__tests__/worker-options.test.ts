import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { createBullmqTransport } from '../transport';

const bullmq = vi.hoisted(() => {
  const instances: WorkerMock[] = [];

  class WorkerMock {
    constructor(
      readonly name: string,
      readonly processor: unknown,
      readonly opts: Record<string, unknown>,
    ) {
      instances.push(this);
    }

    on(): void {}
    async close(): Promise<void> {}
  }

  return { WorkerMock, instances };
});

vi.mock('bullmq', () => ({ Worker: bullmq.WorkerMock }));

const consumeOptions = {
  isFinal: () => false,
  process: async () => 'ok',
  onCompleted: () => undefined,
  onFailed: () => undefined,
  onError: () => undefined,
};

/**
 * The Worker options a consumer is built with are pure construction — asserted
 * against a mocked `bullmq` so no Redis is involved.
 */
describe('bullmq consumer worker options', () => {
  it('applies the transport-wide worker passthrough', () => {
    const transport = createBullmqTransport({
      producer: {} as unknown as Redis,
      consumer: {} as unknown as Redis,
      namespace: 'worker-passthrough',
      worker: { stalledInterval: 5_000, drainDelay: 9 },
    });

    const { worker } = transport.consume('reports', consumeOptions);

    expect(worker.opts.stalledInterval).toBe(5_000);
    expect(worker.opts.drainDelay).toBe(9);
  });

  it('lets core-owned options win over the passthrough', () => {
    const producer = {} as unknown as Redis;
    const consumer = {} as unknown as Redis;
    const transport = createBullmqTransport({
      producer,
      consumer,
      namespace: 'worker-merge',
      worker: {
        concurrency: 99,
        maxStalledCount: 9,
        stalledInterval: 5_000,
      },
    });

    const { worker } = transport.consume('reports', {
      ...consumeOptions,
      concurrency: 4,
      maxStalledCount: 2,
    });

    expect(worker.opts).toMatchObject({
      concurrency: 4,
      maxStalledCount: 2,
      // Untouched by core, so the passthrough survives.
      stalledInterval: 5_000,
    });
    // The transport owns delivery wiring; a passthrough can never redirect it.
    expect(worker.opts.connection).toBe(consumer);
    expect(worker.opts.prefix).toBe('bull:worker-merge');
  });
});
