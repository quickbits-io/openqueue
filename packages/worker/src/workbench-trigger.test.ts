import {
  createQueueWorker,
  type OpenQueueConfig,
  task,
  worldLocal,
} from '@openqueue/core';
import { describe, expect, it } from 'vitest';
import { createWorkbenchForRuntime } from './app';

/**
 * The Workbench Test page selects a job by its `${queue}/${name}` registry id,
 * but string triggers resolve against catalog *ids*. When a task's `name`
 * differs from its `id`, the registry's `enqueueJob` must trigger the catalog
 * id, or the enqueue fails with `task_not_found`.
 */
describe('createWorkbenchForRuntime — test job triggering', () => {
  it('enqueues a job whose name differs from its id', async () => {
    const runtime = await createQueueWorker({
      namespace: 'wb-trigger',
      world: worldLocal(),
      tasks: [
        task({
          id: 'canonical-id',
          name: 'Display Name',
          queue: 'default',
          run: async () => undefined,
        }),
      ],
    });

    const config: OpenQueueConfig = {
      namespace: 'wb-trigger',
      world: worldLocal(),
      tasks: { module: './noop' },
      workbench: { enabled: true },
    };
    const workbench = createWorkbenchForRuntime(runtime, config, []);

    // Registry id is `${queue}/${name}`; without the fix this resolves to
    // trigger('Display Name'), which the catalog rejects.
    await expect(
      workbench.queueManager.enqueueJob({
        type: 'job',
        id: 'default/Display Name',
        data: {},
      }),
    ).resolves.toMatchObject({ type: 'job', name: 'Display Name' });

    await workbench.close();
    await runtime.close();
  });
});
