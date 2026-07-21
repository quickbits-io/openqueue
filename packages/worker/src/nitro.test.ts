import { type OpenQueueConfig, task, worldLocal } from '@openqueue/core';
import { describe, expect, it } from 'vitest';
import { createNitroWorkerPlugin, nitroWorkerFetch } from './nitro';

const noop = task({
  id: 'nitro-noop',
  queue: 'noop',
  run: async () => undefined,
});

const config: OpenQueueConfig = {
  namespace: 'nitro-test',
  world: worldLocal(),
  tasks: { module: './noop' },
};

describe('createNitroWorkerPlugin', () => {
  it('serves 503 before boot, 200 after boot, and drains on the close hook', async () => {
    // Before the plugin runs, Nitro may already accept connections.
    const early = await nitroWorkerFetch(new Request('http://x/health'));
    expect(early.status).toBe(503);

    let closeHook: (() => Promise<void>) | undefined;
    const nitroApp = {
      hooks: {
        hook(_name: 'close', handler: () => Promise<void>) {
          closeHook = handler;
        },
      },
    };

    const plugin = createNitroWorkerPlugin({ config, tasks: [noop] });
    await plugin(nitroApp);

    expect(closeHook).toBeDefined();

    const health = await nitroWorkerFetch(new Request('http://x/health'));
    expect(health.status).toBe(200);
    const ready = await nitroWorkerFetch(new Request('http://x/ready'));
    expect(ready.status).toBe(200);

    // Firing the close hook drains: ready flips to false and the runtime closes.
    await closeHook?.();
    const drained = await nitroWorkerFetch(new Request('http://x/ready'));
    expect(drained.status).toBe(503);
  });
});
