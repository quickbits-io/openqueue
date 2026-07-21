import { type OpenQueueConfig, task, worldLocal } from '@openqueue/core';
import { describe, expect, it } from 'vitest';
import { createNitroWorkerPlugin } from './nitro';

const noop = task({
  id: 'nitro-singleton-noop',
  queue: 'noop',
  run: async () => undefined,
});

const config: OpenQueueConfig = {
  namespace: 'nitro-singleton',
  world: worldLocal(),
  tasks: { module: './noop' },
};

describe('createNitroWorkerPlugin singleton', () => {
  it('rejects a second plugin initialization in the same process', async () => {
    let closeHook: (() => Promise<void>) | undefined;
    const nitroApp = {
      hooks: {
        hook(_name: 'close', handler: () => Promise<void>) {
          closeHook = handler;
        },
      },
    };

    await createNitroWorkerPlugin({ config, tasks: [noop] })(nitroApp);
    await expect(
      createNitroWorkerPlugin({ config, tasks: [noop] })(nitroApp),
    ).rejects.toThrow(/one worker plugin per process/);

    // Drain the one booted runtime so the test leaves no lingering resources.
    await closeHook?.();
  });
});
