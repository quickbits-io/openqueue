import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createBullmqTransport } from '../transport';

const url = process.env.REDIS_URL;

/**
 * Direct callers of the exported `createBullmqTransport({ producer })` (no
 * explicit `consumer`) must get a worker-safe transport. A bare `new Redis(url)`
 * producer keeps ioredis's default `maxRetriesPerRequest`, which BullMQ rejects
 * for blocking (worker) connections — so the transport must duplicate the
 * producer into a `maxRetriesPerRequest: null` consumer it owns, without ever
 * closing or mutating the caller's producer. Mirrors the world-layer guarantee
 * for callers that bypass `worldBullmq`.
 */
describe.skipIf(!url)(
  'createBullmqTransport injected producer (real redis)',
  () => {
    const producer = new Redis(url ?? 'redis://localhost:6380');

    afterAll(async () => {
      await producer.quit().catch(() => undefined);
    });

    it('duplicates a worker-safe blocking consumer for a bare producer and leaves the producer open', async () => {
      const namespace = `tinj-${randomUUID().slice(0, 8)}`;
      const queue = `${namespace}-q`;
      const transport = createBullmqTransport({ producer, namespace });

      const completed: string[] = [];
      const errors: unknown[] = [];
      // Before the fix this throws synchronously: BullMQ refuses a blocking
      // worker connection whose maxRetriesPerRequest is not null.
      const consumer = transport.consume(queue, {
        isFinal: () => false,
        process: async () => 'ok',
        onCompleted: (job) => {
          completed.push(job.id ?? '');
        },
        onFailed: () => undefined,
        onError: (err) => errors.push(err),
      });

      await transport.enqueue(queue, { id: 'j1', name: 'work', data: {} });
      await waitFor(() => completed.length === 1, 5000);

      expect(errors).toEqual([]);
      expect(completed).toEqual(['j1']);

      await consumer.close();
      await transport.close();
      // The transport quit only its spawned blocking connection; the caller's
      // producer must survive.
      expect(producer.status).not.toBe('end');
      expect(await producer.ping()).toBe('PONG');
    });
  },
);

function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) {
        return reject(
          new Error('transport-injected-producer: waitFor timed out'),
        );
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}
