import { task, worldLocal } from '@openqueue/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkerApp } from './app';
import { startWorkerApp } from './index';
import { HOOK_TIMEOUT_MS, runHook } from './lifecycle';

/**
 * `lifecycle.onReady` / `lifecycle.onShutdown` run inside the worker process on
 * both boot paths — the hooks a deploy uses to enqueue release work. Each gets
 * the live runtime, so a trigger from inside one is consumed by this worker; a
 * failing or hung hook is logged and never fails the boot or the drain; the
 * CLI's build-time boot check (`OPENQUEUE_BOOT_CHECK`) skips both so a build can
 * never enqueue.
 */
const noop = task({
  id: 'lifecycle-noop',
  queue: 'noop',
  run: async () => undefined,
});

describe('lifecycle hooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('runs onReady once consumers are up and can trigger a task this worker consumes', async () => {
    const received: unknown[] = [];
    const release = task({
      id: 'release',
      queue: 'release',
      run: async (input: unknown) => {
        received.push(input);
      },
    });

    const app = await startWorkerApp(
      {
        namespace: 'lifecycle-ready',
        world: worldLocal(),
        lifecycle: {
          onReady: (runtime) =>
            runtime.trigger(
              'release',
              { release: 'abc123' },
              { jobId: 'release-abc123' },
            ),
        },
      },
      { port: 0, signals: false, tasks: [release] },
    );

    await vi.waitFor(() => expect(received).toEqual([{ release: 'abc123' }]));

    await app.close();
  });

  it('runs onShutdown before the consumers drain', async () => {
    const order: string[] = [];
    const handle = await createWorkerApp(
      {
        namespace: 'lifecycle-shutdown',
        world: worldLocal(),
        lifecycle: {
          onShutdown: async (runtime) => {
            // The hook is handed the live runtime, so it can still enqueue —
            // that is the point of running it ahead of the drain.
            await runtime.trigger('lifecycle-noop', undefined);
            order.push('hook');
          },
        },
      },
      { tasks: [noop] },
    );

    const drain = handle.runtime.close.bind(handle.runtime);
    vi.spyOn(handle.runtime, 'close').mockImplementation(async () => {
      order.push('drain');
      await drain();
    });

    await handle.close();

    expect(order).toEqual(['hook', 'drain']);
  });

  it('logs a failing hook and still resolves the boot and the drain', async () => {
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const handle = await createWorkerApp(
      {
        namespace: 'lifecycle-throws',
        world: worldLocal(),
        lifecycle: {
          onReady: async () => {
            throw new Error('boom');
          },
          onShutdown: async () => {
            throw new Error('bang');
          },
        },
      },
      { tasks: [noop] },
    );

    expect(error).toHaveBeenCalledWith(
      '[openqueue] onReady hook failed',
      expect.objectContaining({ message: 'boom' }),
    );

    await handle.close();

    expect(error).toHaveBeenCalledWith(
      '[openqueue] onShutdown hook failed',
      expect.objectContaining({ message: 'bang' }),
    );
  });

  it('skips both hooks under the build-time boot check', async () => {
    vi.stubEnv('OPENQUEUE_BOOT_CHECK', '1');
    const onReady = vi.fn();
    const onShutdown = vi.fn();

    const handle = await createWorkerApp(
      {
        namespace: 'lifecycle-boot-check',
        world: worldLocal(),
        lifecycle: { onReady, onShutdown },
      },
      { tasks: [noop] },
    );

    expect(onReady).not.toHaveBeenCalled();

    await handle.close();

    expect(onShutdown).not.toHaveBeenCalled();
  });

  it('abandons a hook that outlives the budget instead of blocking on it', async () => {
    vi.useFakeTimers();
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const pending = runHook('onReady', () => new Promise(() => undefined));

    await vi.advanceTimersByTimeAsync(HOOK_TIMEOUT_MS);
    await expect(pending).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('onReady hook still running'),
    );
  });
});
