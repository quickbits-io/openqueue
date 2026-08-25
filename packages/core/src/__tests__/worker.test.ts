import { describe, expect, it } from 'vitest';
import type { TaskDefinition } from '../types';
import { createLimiter, groupJobsByQueue } from '../worker';

function job(
  name: string,
  queue: string,
  concurrency: number,
  over: Partial<TaskDefinition> = {},
): TaskDefinition {
  return {
    id: name,
    name,
    queue,
    handler: async () => undefined,
    concurrency,
    attempts: 1,
    backoff: { type: 'fixed', delay: 1 },
    tags: [],
    ...over,
  };
}

describe('worker grouping', () => {
  it('groups jobs by queue and applies queue concurrency overrides', () => {
    const groups = groupJobsByQueue(
      [job('a', 'system', 2), job('b', 'system', 7), job('c', 'documents', 4)],
      { system: 3 },
    );

    expect(
      groups.map((group) => ({
        queue: group.queue,
        jobs: group.jobs.map((item) => item.name),
        concurrency: group.concurrency,
      })),
    ).toEqual([
      { queue: 'system', jobs: ['a', 'b'], concurrency: 3 },
      { queue: 'documents', jobs: ['c'], concurrency: 4 },
    ]);
  });

  it('collapses each queue to the most protective delivery options', () => {
    const groups = groupJobsByQueue([
      job('a', 'system', 1, { maxStalledCount: 3, maxDuration: 60_000 }),
      job('b', 'system', 1, { maxStalledCount: 1, maxDuration: 120_000 }),
      job('c', 'documents', 1),
    ]);

    expect(
      groups.map((group) => ({
        queue: group.queue,
        maxStalledCount: group.maxStalledCount,
        maxDuration: group.maxDuration,
      })),
    ).toEqual([
      // The single consumer must cover the longest task budget and give up as
      // early as the least stall-tolerant task.
      { queue: 'system', maxStalledCount: 1, maxDuration: 120_000 },
      {
        queue: 'documents',
        maxStalledCount: undefined,
        maxDuration: undefined,
      },
    ]);
  });
});

describe('worker limiter', () => {
  it('caps concurrent handlers across queues', async () => {
    const limit = createLimiter(2);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        limit(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active--;
        }),
      ),
    );

    expect(maxActive).toBe(2);
  });
});
