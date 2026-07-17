import {
  type OpenQueueConfig,
  resolveNamespace,
  task,
  worldLocal,
} from '@openqueue/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startWorkerApp } from './index';

function config(basePath: string): OpenQueueConfig {
  return {
    namespace: 'test',
    redis: { url: 'redis://localhost:6379' },
    tasks: { module: './noop' },
    workbench: { basePath },
  };
}

describe('validateConfig reserved-prefix guard', () => {
  it('rejects a workbench.basePath equal to the reserved /openqueue prefix', async () => {
    await expect(startWorkerApp(config('/openqueue'))).rejects.toThrow(
      /reserved \/openqueue prefix/,
    );
  });

  it('rejects a workbench.basePath nested under /openqueue/', async () => {
    await expect(startWorkerApp(config('/openqueue/metrics'))).rejects.toThrow(
      /reserved \/openqueue prefix/,
    );
  });
});

describe('validateConfig backend (world XOR redis)', () => {
  it('rejects a config that sets both world and redis', async () => {
    await expect(
      startWorkerApp({
        namespace: 'test',
        world: worldLocal(),
        redis: { url: 'redis://localhost:6379' },
        tasks: { module: './noop' },
      }),
    ).rejects.toThrow(/either redis or world/);
  });

  it('rejects a config that sets neither world nor redis', async () => {
    await expect(
      startWorkerApp({
        namespace: 'test',
        tasks: { module: './noop' },
      }),
    ).rejects.toThrow(/requires redis\.url or world/);
  });

  it('rejects a world paired with a storage adapter', async () => {
    const store = worldLocal()({ namespace: resolveNamespace({}) }).store;
    await expect(
      startWorkerApp({
        namespace: 'test',
        world: worldLocal(),
        storage: { adapter: store },
        tasks: { module: './noop' },
      }),
    ).rejects.toThrow(/world owns durable state/);
  });
});

describe('validateConfig accepts a world-only config', () => {
  const noop = task({
    id: 'config-validation-noop',
    queue: 'noop',
    run: async () => undefined,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('boots worldLocal with no BullMQ queues and no external services', async () => {
    let stopped = false;
    vi.stubGlobal('Bun', {
      serve: (options: { port?: number }) => ({
        port: options.port ?? 0,
        stop: () => {
          stopped = true;
        },
      }),
    });

    const app = await startWorkerApp(
      {
        namespace: 'world-only',
        world: worldLocal(),
        tasks: { module: './noop' },
      },
      { port: 0, signals: false, tasks: [noop] },
    );

    expect(app.runtime.queues.size).toBe(0);

    await app.close();
    expect(stopped).toBe(true);
  });
});
