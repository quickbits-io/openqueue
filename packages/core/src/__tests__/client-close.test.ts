import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createQueueClient } from '../runtime';
import type { TaskDefinition } from '../types';

const url = process.env.REDIS_URL;

/**
 * The client path now builds its own transport (queue cache) rather than
 * reaching for BullMQ directly. This pins that `createQueueClient().close()`
 * closes the transport it owns without hanging, and — when handed a caller-owned
 * Redis client — never closes that borrowed connection (the ownership boundary
 * a transport-owned queue cache could regress).
 */
describe.skipIf(!url)('createQueueClient close (real redis)', () => {
  const borrowed = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  afterAll(async () => {
    await borrowed.quit().catch(() => undefined);
  });

  const def: TaskDefinition = {
    id: 'echo',
    name: 'echo',
    queue: 'client-close-q',
    handler: async () => undefined,
    concurrency: 1,
    attempts: 1,
    backoff: { type: 'fixed', delay: 1 },
    tags: [],
  };

  it('closes cleanly and leaves a borrowed connection open', async () => {
    const client = createQueueClient({
      redis: borrowed,
      namespace: `client-${randomUUID().slice(0, 8)}`,
    });

    // Force the transport to create a queue and connect.
    await client.trigger(def, { hi: true });

    await expect(client.close()).resolves.toBeUndefined();

    // A caller-owned connection must survive the client's close().
    expect(borrowed.status).not.toBe('end');
    expect(await borrowed.ping()).toBe('PONG');
  });
});
