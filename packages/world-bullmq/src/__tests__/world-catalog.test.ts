import { randomUUID } from 'node:crypto';
import { resolveNamespace, taskCatalogEntry } from '@openqueue/core';
import type { QueueStorage, TaskDefinition } from '@openqueue/core/types';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { readQueueCatalog } from '../catalog';
import { worldBullmq } from '../world';
import { memoryStorage } from './support/memory-storage';

/**
 * The `worldBullmq` catalog composite: `publish` fans out to Redis and the
 * durable `storage`; `resolve` reads Redis first and, on a MISS or a Redis
 * ERROR, falls through to `storage` — rethrowing the Redis error only when the
 * store misses too; `read` PROPAGATES Redis errors (the asymmetry with `resolve`
 * is deliberate and preserved). A never-connected, offline-queue-disabled client
 * stands in for a closed connection.
 */
function def(id: string): TaskDefinition {
  return {
    id,
    name: id,
    queue: 'q',
    handler: async () => undefined,
    concurrency: 1,
    attempts: 1,
    backoff: { type: 'fixed', delay: 1 },
    tags: [],
  };
}

const url = process.env.REDIS_URL;

describe.skipIf(!url)('worldBullmq catalog composite (real redis)', () => {
  const clients: Redis[] = [];

  function live(): Redis {
    const redis = new Redis(url ?? 'redis://localhost:6380', {
      maxRetriesPerRequest: null,
    });
    clients.push(redis);
    return redis;
  }

  function dead(): Redis {
    const redis = new Redis(url ?? 'redis://localhost:6380', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: null,
    });
    clients.push(redis);
    // Never connected + offline queue disabled → every command rejects.
    return redis;
  }

  async function seeded(...ids: string[]): Promise<QueueStorage> {
    const storage = memoryStorage();
    if (ids.length > 0)
      await storage.publish(ids.map((id) => taskCatalogEntry(def(id))));
    return storage;
  }

  function build(producer: Redis, storage: QueueStorage) {
    const namespace = resolveNamespace({
      namespace: `parity-${randomUUID()}`,
    }).namespace;
    const world = worldBullmq({ producer, storage })({ namespace });
    return { world, namespace };
  }

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
  });

  it('publish() fans out to redis and the durable storage', async () => {
    const redis = live();
    const storage = await seeded();
    const { world, namespace } = build(redis, storage);

    await world.store.publish([taskCatalogEntry(def('fanout'))]);

    const inRedis = await readQueueCatalog(redis, namespace);
    expect(inRedis.map((entry) => entry.id)).toContain('fanout');
    expect(await storage.resolve('fanout')).toMatchObject({ id: 'fanout' });
  });

  it('resolve() on a redis MISS falls through to storage', async () => {
    const storage = await seeded('only-fb');
    const { world } = build(live(), storage);
    // Nothing is published to redis for this fresh namespace.
    expect(await world.store.resolve('only-fb')).toMatchObject({
      id: 'only-fb',
    });
  });

  it('resolve() on a redis ERROR falls through and returns a storage hit', async () => {
    const storage = await seeded('fb-hit');
    const { world } = build(dead(), storage);
    expect(await world.store.resolve('fb-hit')).toMatchObject({ id: 'fb-hit' });
  });

  it('resolve() on a redis ERROR rethrows when storage misses', async () => {
    const { world } = build(dead(), await seeded());
    await expect(world.store.resolve('nope')).rejects.toThrow();
  });

  it('read() propagates a redis ERROR even when storage has entries', async () => {
    const storage = await seeded('present');
    const { world } = build(dead(), storage);
    await expect(world.store.read()).rejects.toThrow();
  });
});
