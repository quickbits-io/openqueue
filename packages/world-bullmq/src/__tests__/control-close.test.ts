import { randomUUID } from 'node:crypto';
import { createControlRuntime } from '@openqueue/core/control';
import type { TaskDefinition } from '@openqueue/core/types';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { worldBullmq } from '../world';

const url = process.env.REDIS_URL;

/**
 * The control runtime builds its own transport (queue cache) over the BullMQ
 * world. This pins that `createControlRuntime().close()` closes the transport it
 * owns without hanging, and — when handed a caller-owned Redis client via
 * `worldBullmq({ producer })` — never closes that borrowed connection.
 */
describe.skipIf(!url)('producer runtime close (real redis)', () => {
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
    const runtime = await createControlRuntime(
      worldBullmq({ producer: borrowed }),
      { namespace: `client-${randomUUID().slice(0, 8)}` },
    );

    // Force the transport to create a queue and connect.
    await runtime.trigger(def, { hi: true });

    await expect(runtime.close()).resolves.toBeUndefined();

    // A caller-owned connection must survive the runtime's close().
    expect(borrowed.status).not.toBe('end');
    expect(await borrowed.ping()).toBe('PONG');
  });
});
