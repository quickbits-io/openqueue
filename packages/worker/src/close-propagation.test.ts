import { task, worldLocal } from '@openqueue/core';
import { describe, expect, it } from 'vitest';
import { startWorkerApp } from './index';

/**
 * A failed runtime drain/close must reach programmatic callers instead of being
 * swallowed — the signal paths turn it into a non-zero exit. The server socket
 * still closes either way.
 */
describe('worker close propagation', () => {
  it('rejects close() when the runtime close fails, and stays idempotent', async () => {
    const echo = task({
      id: 'echo',
      run: async (input: unknown) => input,
    });
    const app = await startWorkerApp(
      { namespace: 'close-prop', world: worldLocal() },
      { port: 0, signals: false, tasks: [echo] },
    );

    const originalClose = app.runtime.close;
    app.runtime.close = async () => {
      await originalClose();
      throw new Error('drain failed');
    };

    await expect(app.close()).rejects.toThrow('drain failed');
    // The guard is set on entry: a second close is a no-op, not a retry.
    await expect(app.close()).resolves.toBeUndefined();
  });
});
