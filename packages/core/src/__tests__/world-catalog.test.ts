import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import {
  memoryQueueCatalogStore,
  readQueueCatalog,
  taskCatalogEntry,
} from '../catalog';
import { resolveNamespace } from '../namespace';
import type { QueueCatalogStore, TaskDefinition } from '../types';
import { worldBullmq } from '../world-bullmq';

const url = process.env.REDIS_URL;

/**
 * The `worldBullmq` catalog composite (Phase 3 Stage B's named sharp edge):
 * `publish` fans out to Redis and every fallback; `resolve` reads Redis first
 * and, on a MISS or a Redis ERROR, falls through to the fallbacks — rethrowing
 * the Redis error only when no fallback hits; `read` PROPAGATES Redis errors
 * (the asymmetry with `resolve` is deliberate and preserved). A never-connected,
 * offline-queue-disabled client stands in for a closed connection.
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

  function build(producer: Redis, fallback: QueueCatalogStore) {
    const namespace = resolveNamespace({ namespace: `parity-${randomUUID()}` });
    const world = worldBullmq({
      producer,
      catalogFallbacks: [fallback],
      ...namespace,
    })({ namespace });
    return { world, namespace: namespace.namespace };
  }

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
  });

  it('publish() fans out to redis and every fallback', async () => {
    const redis = live();
    const fallback = memoryQueueCatalogStore();
    const { world, namespace } = build(redis, fallback);

    await world.store.publish([taskCatalogEntry(def('fanout'))]);

    const inRedis = await readQueueCatalog(redis, namespace);
    expect(inRedis.map((entry) => entry.id)).toContain('fanout');
    expect(await fallback.resolve('fanout')).toMatchObject({ id: 'fanout' });
  });

  it('resolve() on a redis MISS falls through to the fallback', async () => {
    const fallback = memoryQueueCatalogStore([
      taskCatalogEntry(def('only-fb')),
    ]);
    const { world } = build(live(), fallback);
    // Nothing is published to redis for this fresh namespace.
    expect(await world.store.resolve('only-fb')).toMatchObject({
      id: 'only-fb',
    });
  });

  it('resolve() on a redis ERROR falls through and returns a fallback hit', async () => {
    const fallback = memoryQueueCatalogStore([taskCatalogEntry(def('fb-hit'))]);
    const { world } = build(dead(), fallback);
    expect(await world.store.resolve('fb-hit')).toMatchObject({ id: 'fb-hit' });
  });

  it('resolve() on a redis ERROR rethrows when no fallback hits', async () => {
    const { world } = build(dead(), memoryQueueCatalogStore());
    await expect(world.store.resolve('nope')).rejects.toThrow();
  });

  it('read() propagates a redis ERROR even when a fallback has entries', async () => {
    const fallback = memoryQueueCatalogStore([
      taskCatalogEntry(def('present')),
    ]);
    const { world } = build(dead(), fallback);
    await expect(world.store.read()).rejects.toThrow();
  });
});
