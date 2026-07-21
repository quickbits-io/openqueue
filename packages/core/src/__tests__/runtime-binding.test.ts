import { afterEach, describe, expect, it } from 'vitest';
import { createQueueWorkerFromWorld } from '../runtime';
import { unbindQueueRuntime } from '../task';
import type { TaskDefinition } from '../types';
import { worldLocal } from '../world-local';

/**
 * `ctx.trigger` must enqueue into the runtime that owns the job, not whichever
 * runtime last called the module-global `bindQueueRuntime`. When two worker
 * runtimes coexist in one process, a job running in the first would otherwise
 * enqueue into the last-booted world.
 */
function tasks(onSink: () => void): TaskDefinition[] {
  const base = {
    queue: 'main',
    concurrency: 1,
    attempts: 1,
    backoff: { type: 'fixed', delay: 1 } as const,
    tags: [],
  };
  return [
    {
      ...base,
      id: 'driver',
      name: 'driver',
      handler: async (ctx) => {
        await ctx.trigger('sink', {});
      },
    },
    {
      ...base,
      id: 'sink',
      name: 'sink',
      handler: async () => {
        onSink();
      },
    },
  ];
}

async function waitFor(
  predicate: () => boolean,
  timeout = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('worker ctx.trigger binding', () => {
  afterEach(() => {
    unbindQueueRuntime();
  });

  it('routes ctx.trigger to the job’s own runtime when two runtimes coexist', async () => {
    const sinkRuns: string[] = [];
    const worldA = worldLocal()({ namespace: 'ns-a' });
    const worldB = worldLocal()({ namespace: 'ns-b' });

    const runtimeA = await createQueueWorkerFromWorld(worldA, {
      namespace: 'ns-a',
      tasks: tasks(() => sinkRuns.push('A')),
    });
    // B boots last, so the module-global binding now points at B — the exact
    // condition that made the first runtime's ctx.trigger cross into B.
    const runtimeB = await createQueueWorkerFromWorld(worldB, {
      namespace: 'ns-b',
      tasks: tasks(() => sinkRuns.push('B')),
    });

    await runtimeA.trigger('driver', {});
    await waitFor(() => sinkRuns.length === 1);

    expect(sinkRuns).toEqual(['A']);

    await runtimeA.close();
    await runtimeB.close();
  });
});
