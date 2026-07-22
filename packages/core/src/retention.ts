import type { QueueRunStore, RetentionCutoffs } from './types';

/**
 * Age-based pruning of durable run history. Each window counts from the run's
 * finish time; runs that never finished are never pruned.
 */
export interface RetentionConfig {
  /** Days to keep completed/canceled run records. Default 30. `false` = keep forever. */
  completed?: number | false;
  /** Days to keep failed run records. Default 90. `false` = keep forever. */
  failed?: number | false;
  /** Days to keep run events + spans (the heavy telemetry). Default 30. `false` = keep forever. */
  logs?: number | false;
}

export type RetentionPolicy = Required<RetentionConfig>;

/**
 * Apply the retention defaults (30/90/30 days) and validate explicit windows.
 * Throws on a non-positive or non-finite number of days.
 */
export function resolveRetentionPolicy(
  config: RetentionConfig = {},
): RetentionPolicy {
  return {
    completed: retentionDays('completed', config.completed, 30),
    failed: retentionDays('failed', config.failed, 90),
    logs: retentionDays('logs', config.logs, 30),
  };
}

function retentionDays(
  field: string,
  value: number | false | undefined,
  fallback: number,
): number | false {
  if (value === undefined) return fallback;
  if (value === false) return false;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      `OpenQueue config: retention.${field} must be a positive number of days or false, got ${value}`,
    );
  }
  return value;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Resolve a policy into absolute cutoff dates, anchored at `now`. */
export function retentionCutoffs(
  policy: RetentionPolicy,
  now: Date = new Date(),
): RetentionCutoffs {
  return {
    completedBefore: cutoff(policy.completed, now),
    failedBefore: cutoff(policy.failed, now),
    logsBefore: cutoff(policy.logs, now),
  };
}

function cutoff(days: number | false, now: Date): Date | undefined {
  return days === false ? undefined : new Date(now.getTime() - days * DAY_MS);
}

export interface RetentionSweeper {
  /** Idempotent; clears the initial and hourly timers. */
  close(): void;
}

const INITIAL_SWEEP_DELAY_MS = 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Hourly retention sweep over the store's optional `prune`, plus one initial
 * sweep shortly after boot. No-op (no timers) when the store can't prune or
 * every retention field is `false`. Timers are unref'd so they never hold the
 * process open; a failed sweep is logged and the cadence continues.
 */
export function createRetentionSweeper(
  store: QueueRunStore,
  policy: RetentionPolicy,
): RetentionSweeper {
  const prune = store.prune?.bind(store);
  const disabled =
    policy.completed === false &&
    policy.failed === false &&
    policy.logs === false;
  if (!prune || disabled) return { close: () => {} };

  const sweep = async () => {
    try {
      const { runs, events, spans } = await prune(retentionCutoffs(policy));
      if (runs > 0 || events > 0 || spans > 0) {
        console.log(
          `[openqueue] retention: pruned ${runs} runs, ${events} events, ${spans} spans`,
        );
      }
    } catch (err) {
      console.error('[openqueue] retention sweep failed', err);
    }
  };

  const initial = setTimeout(() => void sweep(), INITIAL_SWEEP_DELAY_MS);
  const interval = setInterval(() => void sweep(), SWEEP_INTERVAL_MS);
  initial.unref?.();
  interval.unref?.();

  return {
    close: () => {
      clearTimeout(initial);
      clearInterval(interval);
    },
  };
}
