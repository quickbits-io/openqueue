import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createBullmqTransport } from '../transport';

const url = process.env.REDIS_URL;

/**
 * A direct user of `createBullmqTransport` who never retains a consumer handle
 * must still have `transport.close()` drain the `Worker`s that `consume()`
 * spawned — otherwise they keep polling Redis and processing after shutdown. The
 * caller-injected (borrowed) connection must survive, matching the local/Postgres
 * transports' close contract.
 */
describe.skipIf(!url)('bullmq transport.close (real redis)', () => {
  const borrowed = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
  });

  afterAll(async () => {
    await borrowed.quit().catch(() => undefined);
  });

  it('drains consumers spawned by consume() and leaves a borrowed connection open', async () => {
    const namespace = `tclose-${randomUUID().slice(0, 8)}`;
    const transport = createBullmqTransport({ producer: borrowed, namespace });
    const queue = `${namespace}-q`;

    const completed: string[] = [];
    // Spawn a consumer but never keep a handle to close it individually — only
    // transport.close() can tear this worker down.
    const { worker } = transport.consume(queue, {
      isFinal: () => false,
      process: async () => 'ok',
      onCompleted: (job) => {
        completed.push(job.id ?? '');
      },
      onFailed: () => undefined,
      onError: () => undefined,
    });

    await transport.enqueue(queue, { id: 'j1', name: 'work', data: {} });
    await waitFor(() => completed.length === 1, 5000);
    expect(worker.isRunning()).toBe(true);

    await transport.close();

    // The worker was drained by transport.close(), not by an individual handle.
    expect(worker.isRunning()).toBe(false);
    // The caller's connection is borrowed — the transport must not quit it.
    expect(borrowed.status).not.toBe('end');
    expect(await borrowed.ping()).toBe('PONG');
  });
});

function waitFor(predicate: () => boolean, timeout = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeout) {
        return reject(new Error('transport-close: waitFor timed out'));
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}
