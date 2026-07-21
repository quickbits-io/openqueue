import { describe, expect, it } from 'vitest';
import { resolveNamespace } from '../namespace';
import { createQueueWorkerFromWorld } from '../runtime';
import { task } from '../task';
import type { OpenQueueWorld } from '../world';
import { worldLocal } from '../world-local';

/**
 * Shutdown must always release the world. A consumer whose `close()` rejects
 * (a BullMQ/custom transport against a failing backend) must not strand the
 * schedule controller and world-owned DB/Redis handles — the world is closed
 * regardless, and the consumer failure surfaces afterward.
 */
describe('createQueueWorkerFromWorld — close cleanup', () => {
  const echo = task({
    id: 'runtime-close-echo',
    queue: 'default',
    run: async (input) => input,
  });

  it('closes the world even when a consumer close rejects, then surfaces the error', async () => {
    let worldClosed = false;
    const base = worldLocal()({ namespace: resolveNamespace({}).namespace });
    const world: OpenQueueWorld = {
      ...base,
      transport: {
        ...base.transport,
        consume: (queue, options) => {
          const consumer = base.transport.consume(queue, options);
          return {
            close: async () => {
              await consumer.close();
              throw new Error('consumer close failed');
            },
          };
        },
      },
      close: async () => {
        worldClosed = true;
        await base.close();
      },
    };

    const runtime = await createQueueWorkerFromWorld(world, { tasks: [echo] });
    await expect(runtime.close()).rejects.toThrow('consumer close failed');
    expect(worldClosed).toBe(true);
  });
});
