import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRetentionSweeper, resolveRetentionPolicy } from '../retention';
import type { PruneResult, QueueRunStore, RetentionCutoffs } from '../types';

/**
 * The hourly retention sweep: an initial sweep ~60s after boot, then one per
 * hour — timers cleared by close, sweep errors logged without breaking the
 * cadence, and no timers at all when the store can't prune or every field is
 * disabled.
 */
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function pruningStore(results: Array<PruneResult | Error>) {
  const calls: RetentionCutoffs[] = [];
  const store: QueueRunStore = {
    list: async () => ({ data: [], hasMore: false }),
    prune: async (cutoffs) => {
      calls.push(cutoffs);
      const result = results[Math.min(calls.length, results.length) - 1];
      if (result instanceof Error) throw result;
      return result ?? { runs: 0, events: 0, spans: 0 };
    },
  };
  return { store, calls };
}

const zeroes: PruneResult = { runs: 0, events: 0, spans: 0 };

describe('createRetentionSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Pin the ±10% jitter to its midpoint (factor 1.0) so timings are exact.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sweeps once ~60s after boot, then hourly', async () => {
    const { store, calls } = pruningStore([zeroes]);
    const sweeper = createRetentionSweeper(store, resolveRetentionPolicy());

    await vi.advanceTimersByTimeAsync(MINUTE - 1);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(calls).toHaveLength(3);

    // Cutoffs derive from the policy at sweep time.
    expect(calls[0]?.completedBefore).toBeInstanceOf(Date);
    expect(calls[0]?.failedBefore).toBeInstanceOf(Date);
    expect(calls[0]?.logsBefore).toBeInstanceOf(Date);

    sweeper.close();
  });

  it('jitters the initial delay and interval by ±10%', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const early = pruningStore([zeroes]);
    const earlySweeper = createRetentionSweeper(
      early.store,
      resolveRetentionPolicy(),
    );
    await vi.advanceTimersByTimeAsync(54_000 - 1); // 0.9 × 60s
    expect(early.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(early.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_240_000); // 0.9 × 1h
    expect(early.calls).toHaveLength(2);
    earlySweeper.close();

    vi.spyOn(Math, 'random').mockReturnValue(1);
    const late = pruningStore([zeroes]);
    const lateSweeper = createRetentionSweeper(
      late.store,
      resolveRetentionPolicy(),
    );
    await vi.advanceTimersByTimeAsync(66_000 - 1); // 1.1 × 60s
    expect(late.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(late.calls).toHaveLength(1);
    lateSweeper.close();
  });

  it('close clears both timers', async () => {
    const { store, calls } = pruningStore([zeroes]);
    const sweeper = createRetentionSweeper(store, resolveRetentionPolicy());
    expect(vi.getTimerCount()).toBe(2);

    sweeper.close();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(calls).toHaveLength(0);
  });

  it('starts no timers when the store cannot prune', () => {
    const store: QueueRunStore = {
      list: async () => ({ data: [], hasMore: false }),
    };
    const sweeper = createRetentionSweeper(store, resolveRetentionPolicy());
    expect(vi.getTimerCount()).toBe(0);
    sweeper.close();
  });

  it('starts no timers when every retention field is false', () => {
    const { store } = pruningStore([zeroes]);
    const sweeper = createRetentionSweeper(
      store,
      resolveRetentionPolicy({ completed: false, failed: false, logs: false }),
    );
    expect(vi.getTimerCount()).toBe(0);
    sweeper.close();
  });

  it('logs a failed sweep and keeps the cadence', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, calls } = pruningStore([new Error('db down'), zeroes]);
    const sweeper = createRetentionSweeper(store, resolveRetentionPolicy());

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(calls).toHaveLength(1);
    expect(error).toHaveBeenCalledWith(
      '[openqueue] retention sweep failed',
      expect.any(Error),
    );

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(calls).toHaveLength(2);

    sweeper.close();
  });

  it('stays silent on a skipped prune (another replica holds the lock)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { store, calls } = pruningStore([{ skipped: true }]);
    const sweeper = createRetentionSweeper(store, resolveRetentionPolicy());

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(calls).toHaveLength(1);
    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();

    sweeper.close();
  });

  it('logs the pruned line only when something was deleted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { store } = pruningStore([zeroes, { runs: 2, events: 4, spans: 3 }]);
    const sweeper = createRetentionSweeper(store, resolveRetentionPolicy());

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(log).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(HOUR);
    expect(log).toHaveBeenCalledWith(
      '[openqueue] retention: pruned 2 runs, 4 events, 3 spans',
    );

    sweeper.close();
  });
});
