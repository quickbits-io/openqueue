import type {
  EnqueueMeta,
  QueueRun,
  QueueRunListOptions,
  QueueRunListResult,
  QueueRunSnapshot,
  QueueSchedule,
  QueueScheduleListOptions,
  RunStatus,
} from '../types';

/** Statuses a run never leaves — its outcome is final. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'completed',
  'failed',
  'canceled',
  'timed_out',
  'expired',
];

export function isTerminalRunStatus(status: string | undefined): boolean {
  return (
    status !== undefined &&
    (TERMINAL_RUN_STATUSES as readonly string[]).includes(status)
  );
}

export function filterSchedules(
  schedules: QueueSchedule[],
  options: QueueScheduleListOptions | undefined,
): QueueSchedule[] {
  const offset = cursorOffset(options?.cursor);
  const limit = options?.limit
    ? Math.min(Math.max(options.limit, 1), 500)
    : undefined;
  const filtered = schedules.filter((schedule) => {
    if (options?.task && schedule.task !== options.task) return false;
    if (options?.externalId && schedule.externalId !== options.externalId) {
      return false;
    }
    if (options?.active !== undefined && schedule.active !== options.active) {
      return false;
    }
    if (options?.meta && !containsMeta(schedule.meta, options.meta)) {
      return false;
    }
    return true;
  });
  filtered.sort(scheduleSorter(options));
  return filtered.slice(offset, limit ? offset + limit : undefined);
}

function scheduleSorter(options: QueueScheduleListOptions | undefined) {
  const field = options?.sort?.field ?? 'nextRun';
  const direction = options?.sort?.direction ?? 'asc';
  return (a: QueueSchedule, b: QueueSchedule) =>
    compareDates(
      scheduleSortDate(a, field),
      scheduleSortDate(b, field),
      direction,
    );
}

function scheduleSortDate(
  schedule: QueueSchedule,
  field: NonNullable<QueueScheduleListOptions['sort']>['field'],
): Date | undefined {
  return {
    nextRun: schedule.nextRun,
    lastRun: schedule.lastRun,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  }[field];
}

export function filterRuns(
  runs: QueueRun[],
  options: QueueRunListOptions | undefined,
): QueueRunListResult {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 500);
  const offset = cursorOffset(options?.cursor);
  const filtered = runs.filter((run) => {
    if (options?.id && run.id !== options.id) return false;
    if (options?.task && run.task !== options.task) return false;
    if (options?.status && run.status !== options.status) return false;
    if (options?.scheduleId && run.scheduleId !== options.scheduleId) {
      return false;
    }
    if (
      options?.scheduleExternalId &&
      run.scheduleExternalId !== options.scheduleExternalId
    ) {
      return false;
    }
    if (options?.meta && !containsMeta(run.meta, options.meta)) return false;
    if (options?.timeRange) {
      const time = run.createdAt.getTime();
      if (
        time < options.timeRange.start.getTime() ||
        time > options.timeRange.end.getTime()
      ) {
        return false;
      }
    }
    return true;
  });
  filtered.sort(runSorter(options));
  const data = filtered.slice(offset, offset + limit);
  const hasMore = filtered.length > offset + limit;
  return {
    data,
    hasMore,
    cursor: hasMore ? String(offset + limit) : undefined,
  };
}

function runSorter(options: QueueRunListOptions | undefined) {
  const field = options?.sort?.field ?? 'createdAt';
  const direction = options?.sort?.direction ?? 'desc';
  return (a: QueueRun, b: QueueRun) =>
    compareDates(runSortDate(a, field), runSortDate(b, field), direction);
}

function runSortDate(
  run: QueueRun,
  field: NonNullable<QueueRunListOptions['sort']>['field'],
): Date | undefined {
  return {
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    updatedAt: run.updatedAt,
  }[field];
}

export function runFromSnapshot(run: QueueRunSnapshot): QueueRun {
  return {
    id: run.id,
    transportJobId: run.transportJobId,
    task: run.name,
    queue: run.queue,
    status: run.status,
    input: run.input,
    output: run.output,
    error: run.error,
    meta: run.meta,
    metadata: run.metadata,
    tags: run.tags,
    scheduleId: run.scheduleId,
    scheduleExternalId: run.scheduleExternalId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    updatedAt: new Date(),
  };
}

/**
 * Deep-containment match mirroring Postgres `@>`: nested objects recurse,
 * arrays match when every expected element is contained in some actual
 * element, and scalars compare with `===`. Exported for unit testing; not part
 * of the public package surface.
 */
export function containsMeta(
  meta: EnqueueMeta,
  filter: Record<string, unknown>,
): boolean {
  return Object.entries(filter).every(([key, value]) =>
    deepContains(meta[key], value),
  );
}

function deepContains(actual: unknown, expected: unknown): boolean {
  if (isMetaRecord(expected)) {
    if (!isMetaRecord(actual)) return false;
    return Object.entries(expected).every(([key, value]) =>
      deepContains(actual[key], value),
    );
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((expectedItem) =>
      actual.some((actualItem) => deepContains(actualItem, expectedItem)),
    );
  }
  return actual === expected;
}

function isMetaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareDates(
  a: Date | undefined,
  b: Date | undefined,
  direction: 'asc' | 'desc',
): number {
  const left = a?.getTime() ?? (direction === 'asc' ? Infinity : -Infinity);
  const right = b?.getTime() ?? (direction === 'asc' ? Infinity : -Infinity);
  return direction === 'asc' ? left - right : right - left;
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
