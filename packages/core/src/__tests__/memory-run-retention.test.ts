import { describe, expect, it } from 'vitest';
import { memoryQueueStorage } from '../store/memory';
import type { QueueRunSnapshot, RunStatus } from '../types';

/**
 * Age-based retention over the in-memory run cache: terminal runs past their
 * bucket's cutoff (counted from `finishedAt`) are deleted; unfinished runs
 * never are, no matter how old.
 */
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

async function seededStorage() {
  const storage = memoryQueueStorage();
  const seeds: Array<[string, RunStatus, number | undefined]> = [
    ['old-completed', 'completed', 40],
    ['new-completed', 'completed', 10],
    ['old-canceled', 'canceled', 40],
    ['old-failed', 'failed', 100],
    ['mid-failed', 'failed', 40],
    ['old-timed-out', 'timed_out', 100],
    ['ancient-executing', 'executing', undefined],
  ];
  for (const [id, status, finishedDaysAgo] of seeds) {
    await storage.handle({
      type: status === 'executing' ? 'start' : 'complete',
      run: snapshot(id, status, finishedDaysAgo),
    });
  }
  return storage;
}

async function listedIds(storage: Awaited<ReturnType<typeof seededStorage>>) {
  const result = await storage.runs.list({ limit: 500 });
  return result.data.map((run) => run.id).sort();
}

describe('store — memory run retention prune', () => {
  it('prunes terminal runs past their bucket cutoff, never unfinished ones', async () => {
    const storage = await seededStorage();

    const result = await storage.runs.prune?.({
      completedBefore: daysAgo(30),
      failedBefore: daysAgo(90),
      logsBefore: daysAgo(30),
    });

    // completed/canceled past 30d and failed/timed_out past 90d go; the
    // memory store holds no events or spans.
    expect(result).toEqual({ runs: 4, events: 0, spans: 0 });
    expect(await listedIds(storage)).toEqual([
      'ancient-executing',
      'mid-failed',
      'new-completed',
    ]);
  });

  it('prunes nothing when every cutoff is unset', async () => {
    const storage = await seededStorage();

    const result = await storage.runs.prune?.({});

    expect(result).toEqual({ runs: 0, events: 0, spans: 0 });
    expect(await listedIds(storage)).toHaveLength(7);
  });
});
