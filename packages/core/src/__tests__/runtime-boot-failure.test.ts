import { describe, expect, it } from 'vitest';
import { resolveNamespace } from '../namespace';
import { createQueueWorkerFromWorld } from '../runtime';
import { task } from '../task';
import type { OpenQueueWorld } from '../world';
import { worldLocal } from '../world-local';

/**
 * A boot that fails after the world opened resources must close the world, or
 * programmatic boots leak DB/Redis handles. Mirrors `worldPostgres` reporting
 * pending migrations from `start()` after opening a client.
 */
describe('createQueueWorkerFromWorld — boot failure cleanup', () => {
  const bootTask = task({
    id: 'boot-failure-echo',
    queue: 'default',
    run: async (input) => input,
  });

  it('closes the world when start() throws', async () => {
    let closed = false;
    const base = worldLocal()({ namespace: resolveNamespace({}).namespace });
    const world: OpenQueueWorld = {
      ...base,
      start: async () => {
        throw new Error('pending migrations');
      },
      close: async () => {
        closed = true;
        await base.close();
      },
    };

    await expect(
      createQueueWorkerFromWorld(world, { tasks: [bootTask] }),
    ).rejects.toThrow('pending migrations');
    expect(closed).toBe(true);
  });

  it('closes the world when publish() throws', async () => {
    let closed = false;
    const base = worldLocal()({ namespace: resolveNamespace({}).namespace });
    const world: OpenQueueWorld = {
      ...base,
      store: {
        ...base.store,
        publish: async () => {
          throw new Error('publish failed');
        },
      },
      close: async () => {
        closed = true;
        await base.close();
      },
    };

    await expect(
      createQueueWorkerFromWorld(world, { tasks: [bootTask] }),
    ).rejects.toThrow('publish failed');
    expect(closed).toBe(true);
  });
});
