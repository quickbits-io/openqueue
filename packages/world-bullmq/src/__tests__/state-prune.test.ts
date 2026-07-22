import { randomUUID } from 'node:crypto';
import type {
  QueueRunSnapshot,
  QueueStorage,
  RunStatus,
} from '@openqueue/core/types';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedisQueueState, redisKey } from '../state';
import { memoryStorage } from './support/memory-storage';

/**
 * Retention prune over the Redis run cache: the zset index is scored by write
 * time, so aged terminal entries are evicted per status bucket, unfinished
 * runs survive, and a durable store's `prune` supplies the authoritative
 * counts when present.
 */
const url = process.env.REDIS_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function snapshot(
  id: string,
  status: RunStatus,
  finishedDaysAgo?: number,
): QueueRunSnapshot {
  return {
    id,
    name: 'echo',
    queue: 'default',
    status,
    input: {},
    meta: {},
    metadata: {},
    tags: [],
    attempt: 1,
    maxAttempts: 1,
    willRetry: false,
    createdAt: daysAgo(200),
    finishedAt:
      finishedDaysAgo === undefined ? undefined : daysAgo(finishedDaysAgo),
  };
}

describe.skipIf(!url)('redis state — run cache retention prune', () => {
  const redis = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
  });

  afterAll(async () => {
    await redis.quit();
  });

  async function seed(
    state: ReturnType<typeof createRedisQueueState>,
    namespace: string,
    seeds: Array<[string, RunStatus, number | undefined]>,
  ) {
    for (const [id, status, finishedDaysAgo] of seeds) {
      await state.handle({
        type: status === 'executing' ? 'start' : 'complete',
        run: snapshot(id, status, finishedDaysAgo),
      });
      // handle() scores the index entry with the (fresh) write time; backdate
      // aged runs so the cache looks the way it would after real elapsed time.
      if (finishedDaysAgo !== undefined) {
        await redis.zadd(
          redisKey(namespace, 'runs:index'),
          daysAgo(finishedDaysAgo).getTime(),
          id,
        );
      }
    }
  }

  it('evicts aged terminal entries per bucket and keeps the rest', async () => {
    const namespace = `retention-${randomUUID()}`;
    const state = createRedisQueueState(redis, undefined, namespace);
    await seed(state, namespace, [
      ['old-completed', 'completed', 40],
      ['fresh-completed', 'completed', 1],
      ['old-failed', 'failed', 100],
      ['mid-failed', 'failed', 40],
      ['stale-executing', 'executing', undefined],
    ]);
    // An unfinished run parked deep in the past must still survive.
    await redis.zadd(
      redisKey(namespace, 'runs:index'),
      daysAgo(150).getTime(),
      'stale-executing',
    );

    const result = await state.runs.prune?.({
      completedBefore: daysAgo(30),
      failedBefore: daysAgo(90),
    });

    expect(result).toEqual({ runs: 2, events: 0, spans: 0 });
    const cached = await redis.hkeys(redisKey(namespace, 'runs'));
    expect(cached.sort()).toEqual([
      'fresh-completed',
      'mid-failed',
      'stale-executing',
    ]);
    const indexed = await redis.zrange(
      redisKey(namespace, 'runs:index'),
      0,
      -1,
    );
    expect(indexed.sort()).toEqual([
      'fresh-completed',
      'mid-failed',
      'stale-executing',
    ]);
  });

  it('delegates to a pruning durable store for the counts and still trims the cache', async () => {
    const namespace = `retention-${randomUUID()}`;
    const durable = memoryStorage();
    const seeds: Array<[string, RunStatus, number | undefined]> = [
      ['old-completed', 'completed', 40],
      ['fresh-completed', 'completed', 1],
    ];
    for (const [id, status, finishedDaysAgo] of seeds) {
      await durable.handle({
        type: 'complete',
        run: snapshot(id, status, finishedDaysAgo),
      });
    }
    const state = createRedisQueueState(redis, durable, namespace);
    await seed(state, namespace, seeds);

    const result = await state.runs.prune?.({ completedBefore: daysAgo(30) });

    // The durable store's counts, not the cache eviction count.
    expect(result).toEqual({ runs: 1, events: 0, spans: 0 });
    expect(await redis.hget(redisKey(namespace, 'runs'), 'old-completed')).toBe(
      null,
    );
    const durableRuns = await durable.runs.list({ limit: 500 });
    expect(durableRuns.data.map((run) => run.id)).toEqual(['fresh-completed']);
  });

  it('omits prune entirely when the durable store cannot prune', () => {
    const namespace = `retention-${randomUUID()}`;
    const durable: QueueStorage = {
      ...memoryStorage(),
      runs: { list: async () => ({ data: [], hasMore: false }) },
    };
    const state = createRedisQueueState(redis, durable, namespace);
    expect(state.runs.prune).toBeUndefined();
  });
});
