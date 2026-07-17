import { randomUUID } from 'node:crypto';
import type { QueueRunSnapshot, QueueStorage } from '@openqueue/core/types';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { redisKey } from '../state';
import { worldBullmq } from '../world';
import { memoryStorage } from './support/memory-storage';

const url = process.env.REDIS_URL;

/**
 * Write-through parity for the extraction's one real behaviour repair: the world
 * now composes the durable-storage drain itself (`composeDrains(state, storage)`
 * inside `worldBullmq`), replacing the old separate-drain wiring that runtime.ts
 * used to add. This pins the observable contract that move must preserve — a run
 * event, a schedule, and an alert must all land in BOTH the Redis cache AND the
 * durable store — plus the fan-out isolation the composition inherits from the
 * old `Promise.allSettled` drain list (a failing durable side must not lose the
 * Redis write).
 */
describe.skipIf(!url)('worldBullmq write-through parity (real redis)', () => {
  const redis = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
  });

  afterAll(async () => {
    await redis.quit().catch(() => undefined);
  });

  function snapshot(over: Partial<QueueRunSnapshot> = {}): QueueRunSnapshot {
    const id = over.id ?? `run-${randomUUID()}`;
    return {
      id,
      name: 'echo',
      queue: 'default',
      status: 'completed',
      input: { hi: true },
      output: { echoed: true },
      meta: {},
      metadata: {},
      tags: [],
      attempt: 1,
      maxAttempts: 1,
      willRetry: false,
      createdAt: new Date(),
      ...over,
    };
  }

  async function readRedisRun(namespace: string, id: string) {
    const raw = await redis.hget(redisKey(namespace, 'runs'), id);
    return raw ? (JSON.parse(raw) as { status: string }) : undefined;
  }

  it('a run event fans out to both the Redis cache and the durable store', async () => {
    const namespace = `parity-run-${randomUUID().slice(0, 8)}`;
    const storage = memoryStorage();
    const world = worldBullmq({ producer: redis, storage })({ namespace });

    const run = snapshot();
    await world.store.handle({ type: 'complete', run });

    const cached = await readRedisRun(namespace, run.id);
    expect(cached?.status).toBe('completed');

    const durable = await storage.runs.list({ id: run.id });
    expect(durable.data.map((entry) => entry.id)).toContain(run.id);
    expect(durable.data[0]?.status).toBe('completed');

    await world.close();
  });

  it('keeps the Redis write when the durable drain throws (allSettled isolation)', async () => {
    const namespace = `parity-iso-${randomUUID().slice(0, 8)}`;
    const base = memoryStorage();
    const storage: QueueStorage = {
      ...base,
      handle: async () => {
        throw new Error('durable down');
      },
    };
    const world = worldBullmq({ producer: redis, storage })({ namespace });

    const run = snapshot();
    // Must resolve — a broken durable drain cannot reject the composed handle.
    await expect(
      world.store.handle({ type: 'complete', run }),
    ).resolves.toBeUndefined();

    const cached = await readRedisRun(namespace, run.id);
    expect(cached?.status).toBe('completed');

    await world.close();
  });

  it('a schedule create writes through to both the durable store and Redis', async () => {
    const namespace = `parity-sched-${randomUUID().slice(0, 8)}`;
    const storage = memoryStorage();
    const world = worldBullmq({ producer: redis, storage })({ namespace });

    const id = `sched-${randomUUID()}`;
    await world.store.schedules.create({
      id,
      task: 'echo',
      input: { hi: true },
      cron: '*/5 * * * *',
      timezone: 'UTC',
      nextRunAt: new Date(Date.now() + 60_000),
      deduplicationKey: `dedupe-${id}`,
    });

    expect(await storage.schedules.retrieve(id)).toMatchObject({ id });
    expect(
      await redis.hget(redisKey(namespace, 'schedules'), id),
    ).not.toBeNull();

    await world.close();
  });

  it('an alert contact point writes through to both the durable store and Redis', async () => {
    const namespace = `parity-alert-${randomUUID().slice(0, 8)}`;
    const storage = memoryStorage();
    const world = worldBullmq({ producer: redis, storage })({ namespace });

    const point = await world.store.alerts.createContactPoint({
      name: 'ops',
      preset: 'webhook',
      url: 'https://example.test/hook',
      enabled: true,
    });

    expect(await storage.alerts.getContactPoint(point.id)).toMatchObject({
      id: point.id,
    });
    expect(
      await redis.hget(redisKey(namespace, 'alerts:contacts'), point.id),
    ).not.toBeNull();

    await world.close();
  });
});
