import type { RetentionCutoffs } from './types';

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
