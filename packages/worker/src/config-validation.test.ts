import {
  createQueueWorker,
  type OpenQueueConfig,
  resolveNamespace,
  task,
  worldLocal,
} from '@openqueue/core';
import { isBullmqTransport } from '@openqueue/world-bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkbenchForRuntime, startWorkerApp } from './index';

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
    const store = worldLocal()({
      namespace: resolveNamespace({}).namespace,
    }).store;
    await expect(
      startWorkerApp({
        namespace: 'test',
        world: worldLocal(),
        storage: store,
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

    expect(isBullmqTransport(app.runtime.transport)).toBe(false);

    await app.close();
    expect(stopped).toBe(true);
  });
});

describe('createWorkbenchForRuntime base path', () => {
  const noop = task({
    id: 'base-path-noop',
    queue: 'noop',
    run: async () => undefined,
  });

  it('defaults basePath to the /workbench mount so mounted assets resolve', async () => {
    const runtime = await createQueueWorker({
      namespace: 'wb-base',
      world: worldLocal(),
      tasks: [noop],
    });
    const config: OpenQueueConfig = {
      namespace: 'wb-base',
      world: worldLocal(),
      tasks: { module: './noop' },
      workbench: { enabled: true },
    };

    const core = createWorkbenchForRuntime(runtime, config, []);
    expect(core.options.basePath).toBe('/workbench');

    await runtime.close();
  });

  it('respects an explicit basePath', async () => {
    const runtime = await createQueueWorker({
      namespace: 'wb-explicit',
      world: worldLocal(),
      tasks: [noop],
    });
    const config: OpenQueueConfig = {
      namespace: 'wb-explicit',
      world: worldLocal(),
      tasks: { module: './noop' },
      workbench: { enabled: true, basePath: '/admin/jobs' },
    };

    const core = createWorkbenchForRuntime(runtime, config, []);
    expect(core.options.basePath).toBe('/admin/jobs');

    await runtime.close();
  });
});
