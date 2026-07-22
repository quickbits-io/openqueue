import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueueWorker } from '../runtime';
import { task } from '../task';
import type { TaskDefinition } from '../types';
import { worldLocal } from '../world-local';

/**
 * The runtime owns the retention sweep when (and only when) the `retention`
 * option is set — the worker app always passes its resolved policy, while
 * embedded runtimes opt in explicitly and never get silent data deletion.
 */
const { closeSpy, sweeperSpy } = vi.hoisted(() => {
  const closeSpy = vi.fn();
  return { closeSpy, sweeperSpy: vi.fn(() => ({ close: closeSpy })) };
});

vi.mock('../retention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../retention')>()),
  createRetentionSweeper: sweeperSpy,
}));

function noop(id: string): TaskDefinition {
  return task({ id, queue: 'noop', run: async () => undefined });
}

describe('createQueueWorker retention wiring', () => {
  beforeEach(() => {
    sweeperSpy.mockClear();
    closeSpy.mockClear();
  });

  it('starts the sweeper with the resolved policy and closes it with the runtime', async () => {
    const runtime = await createQueueWorker({
      namespace: 'retention-wired',
      world: worldLocal(),
      tasks: [noop('retention-wired-noop')],
      retention: { completed: 7 },
    });

    expect(sweeperSpy).toHaveBeenCalledTimes(1);
    expect(sweeperSpy).toHaveBeenCalledWith(runtime.runs, {
      completed: 7,
      failed: 90,
      logs: 30,
    });
    expect(closeSpy).not.toHaveBeenCalled();

    await runtime.close();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('runs no sweeper when the retention option is unset', async () => {
    const runtime = await createQueueWorker({
      namespace: 'retention-unwired',
      world: worldLocal(),
      tasks: [noop('retention-unwired-noop')],
    });

    expect(sweeperSpy).not.toHaveBeenCalled();
    await runtime.close();
  });

  it('rejects an invalid retention window during boot', async () => {
    await expect(
      createQueueWorker({
        namespace: 'retention-invalid',
        world: worldLocal(),
        tasks: [noop('retention-invalid-noop')],
        retention: { completed: 0 },
      }),
    ).rejects.toThrow(/retention\.completed must be a positive number/);
  });
});
