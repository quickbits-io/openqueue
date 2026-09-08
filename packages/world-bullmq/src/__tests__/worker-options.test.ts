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
  it('applies the lease core derives from the queue task budgets', () => {
    const transport = createBullmqTransport({
      producer: {} as unknown as Redis,
      consumer: {} as unknown as Redis,
      namespace: 'lock-per-task',
    });

    const { worker } = transport.consume('reports', {
      ...consumeOptions,
      lockDuration: 90_000,
    });

    expect(worker.opts.lockDuration).toBe(90_000);
  });

  it('falls back to the transport-wide worker passthrough', () => {
    const transport = createBullmqTransport({
      producer: {} as unknown as Redis,
      consumer: {} as unknown as Redis,
      namespace: 'lock-passthrough',
      worker: { lockDuration: 45_000, stalledInterval: 5_000 },
    });

    const { worker } = transport.consume('reports', consumeOptions);

    expect(worker.opts.lockDuration).toBe(45_000);
    expect(worker.opts.stalledInterval).toBe(5_000);
  });

  it('lets core-owned options win over the passthrough', () => {
    const producer = {} as unknown as Redis;
    const consumer = {} as unknown as Redis;
    const transport = createBullmqTransport({
      producer,
      consumer,
      namespace: 'lock-merge',
      worker: {
        concurrency: 99,
        maxStalledCount: 9,
        lockDuration: 45_000,
        stalledInterval: 5_000,
      },
    });

    const { worker } = transport.consume('reports', {
      ...consumeOptions,
      concurrency: 4,
      maxStalledCount: 2,
      lockDuration: 90_000,
    });

    expect(worker.opts).toMatchObject({
      concurrency: 4,
      maxStalledCount: 2,
      lockDuration: 90_000,
      // Untouched by core, so the passthrough survives.
      stalledInterval: 5_000,
    });
    // The transport owns delivery wiring; a passthrough can never redirect it.
    expect(worker.opts.connection).toBe(consumer);
    expect(worker.opts.prefix).toBe('bull:lock-merge');
  });
});
