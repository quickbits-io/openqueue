import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { worldBullmq } from '../world';

const url = process.env.REDIS_URL;

/**
 * The documented `worldBullmq({ producer })` form (no explicit `consumer`) must
 * yield a worker-safe world. A bare `new Redis(url)` producer keeps ioredis's
 * default `maxRetriesPerRequest`, which BullMQ rejects for blocking (worker)
 * connections — so the world must duplicate it into a `maxRetriesPerRequest: null`
 * consumer rather than reuse the producer.
 */
describe.skipIf(!url)('worldBullmq injected producer (real redis)', () => {
  const producer = new Redis(url ?? 'redis://localhost:6380');

  afterAll(async () => {
    await producer.quit().catch(() => undefined);
  });

  it('duplicates a worker-safe blocking consumer so a bare producer can run workers', async () => {
    const namespace = `inj-${randomUUID().slice(0, 8)}`;
    const world = worldBullmq({ producer })({ namespace });
    const queue = `${namespace}-q`;

    const completed: string[] = [];
    const errors: unknown[] = [];
    // Before the fix this throws synchronously: BullMQ refuses a blocking worker
    // connection whose maxRetriesPerRequest is not null.
    const consumer = world.transport.consume(queue, {
      isFinal: () => false,
      process: async () => 'ok',
      onCompleted: (job) => {
        completed.push(job.id ?? '');
      },
      onFailed: () => undefined,
      onError: (err) => errors.push(err),
    });

    await world.transport.enqueue(queue, { id: 'j1', name: 'work', data: {} });
    await waitFor(() => completed.length === 1, 5000);

    expect(errors).toEqual([]);
    expect(completed).toEqual(['j1']);

    await consumer.close();
    await world.close();
    // The caller's producer is borrowed — the world must not quit it on close.
    expect(producer.status).not.toBe('end');
    expect(await producer.ping()).toBe('PONG');
  });
});

function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) {
        return reject(new Error('injected-producer: waitFor timed out'));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}
