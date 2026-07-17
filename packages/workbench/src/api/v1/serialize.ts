import {
  runStatusSchema,
  type WireCatalogEntry,
  type WireEnqueueOptions,
  type WireErrorCode,
  type WireRun,
  type WireSchedule,
} from '@openqueue/client/wire';
import type {
  EnqueueOptions,
  QueueCatalogEntry,
  QueueRun,
  QueueRunListOptions,
  QueueSchedule,
  QueueScheduleListOptions,
} from '@openqueue/core';
import type { HandlerResult } from '../handlers';

const RUN_SORT_FIELDS = [
  'createdAt',
  'startedAt',
  'finishedAt',
  'updatedAt',
] as const;
const SCHEDULE_SORT_FIELDS = [
  'nextRun',
  'lastRun',
  'createdAt',
  'updatedAt',
] as const;

export function wireRun(run: QueueRun): WireRun {
  return {
    id: run.id,
    transportJobId: run.transportJobId,
    task: run.task,
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
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

export function wireSchedule(schedule: QueueSchedule): WireSchedule {
  return {
    id: schedule.id,
    type: schedule.type,
    task: schedule.task,
    input: schedule.input,
    active: schedule.active,
    cron: schedule.cron,
    timezone: schedule.timezone,
    externalId: schedule.externalId,
    deduplicationKey: schedule.deduplicationKey,
    meta: schedule.meta,
    nextRun: schedule.nextRun?.toISOString(),
    lastRun: schedule.lastRun?.toISOString(),
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

export function wireCatalogEntry(entry: QueueCatalogEntry): WireCatalogEntry {
  return {
    id: entry.id,
    name: entry.name,
    queue: entry.queue,
    attempts: entry.attempts,
    backoff: entry.backoff,
    concurrency: entry.concurrency,
    ttl: entry.ttl,
    maxStalledCount: entry.maxStalledCount,
    cron: entry.cron,
    tags: entry.tags,
    description: entry.description,
    schema: entry.schema,
    updatedAt: entry.updatedAt,
    version: entry.version,
  };
}

/** A parsed query, or the invalid values that failed validation. */
export type QueryParse<T> =
  | { ok: true; options: T }
  | { ok: false; issues: QueryIssue[] };

type QueryIssue = { path: string; message: string };

export function toRunListOptions(
  query: Record<string, string | undefined>,
): QueryParse<QueueRunListOptions> {
  const issues: QueryIssue[] = [];
  const options: QueueRunListOptions = {};
  if (query.id) options.id = query.id;
  if (query.task) options.task = query.task;
  if (query.scheduleId) options.scheduleId = query.scheduleId;
  if (query.scheduleExternalId) {
    options.scheduleExternalId = query.scheduleExternalId;
  }

  if (query.status !== undefined) {
    const status = runStatusSchema.safeParse(query.status);
    if (status.success) options.status = status.data;
    else
      issues.push({
        path: 'status',
        message: `Invalid status "${query.status}"`,
      });
  }

  const meta = parseMetaFilter(query.meta, issues);
  if (meta) options.meta = meta;

  const timeRange = parseTimeRange(query.start, query.end, issues);
  if (timeRange) options.timeRange = timeRange;

  const sort = parseSort(query.sort, RUN_SORT_FIELDS, issues);
  if (sort) options.sort = sort;

  const limit = parseLimit(query.limit, issues);
  if (limit !== undefined) options.limit = limit;
  if (query.cursor) options.cursor = query.cursor;

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, options };
}

export function toScheduleListOptions(
  query: Record<string, string | undefined>,
): QueryParse<QueueScheduleListOptions> {
  const issues: QueryIssue[] = [];
  const options: QueueScheduleListOptions = {};
  if (query.task) options.task = query.task;
  if (query.externalId) options.externalId = query.externalId;
  if (query.active !== undefined) {
    if (query.active === 'true') options.active = true;
    else if (query.active === 'false') options.active = false;
    else
      issues.push({
        path: 'active',
        message: `Invalid active "${query.active}" (expected true or false)`,
      });
  }

  const meta = parseMetaFilter(query.meta, issues);
  if (meta) options.meta = meta;

  const sort = parseSort(query.sort, SCHEDULE_SORT_FIELDS, issues);
  if (sort) options.sort = sort;

  const limit = parseLimit(query.limit, issues);
  if (limit !== undefined) options.limit = limit;
  if (query.cursor) options.cursor = query.cursor;

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, options };
}

export function toEnqueueOptions(
  options: WireEnqueueOptions | undefined,
): EnqueueOptions | undefined {
  if (!options) return undefined;
  return {
    runId: options.runId,
    jobId: options.jobId,
    delay: options.delay,
    priority: options.priority,
    attempts: options.attempts,
    backoff: options.backoff,
    ttl: options.ttl,
    meta: options.meta,
  };
}

export function controlError(
  code: WireErrorCode,
  message: string,
  issues?: { path: string; message: string }[],
): HandlerResult {
  return {
    status: statusForCode(code),
    body: { error: { code, message, ...(issues ? { issues } : {}) } },
  };
}

function statusForCode(code: WireErrorCode): number {
  switch (code) {
    case 'unauthorized':
      return 401;
    case 'forbidden':
      return 403;
    case 'invalid_request':
      return 400;
    case 'task_not_found':
    case 'run_not_found':
    case 'schedule_not_found':
      return 404;
    case 'internal':
      return 500;
  }
}

function parseMetaFilter(
  value: string | undefined,
  issues: { path: string; message: string }[],
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    issues.push({
      path: 'meta',
      message: 'Invalid meta filter (must be valid JSON)',
    });
    return undefined;
  }
  // A meta filter is a deep-containment spec, so any JSON object is valid
  // (partial nested objects included) — it is not the full meta schema.
  if (!isJsonObject(raw)) {
    issues.push({
      path: 'meta',
      message: 'Invalid meta filter (must be a JSON object)',
    });
    return undefined;
  }
  return raw;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseSort<F extends string>(
  value: string | undefined,
  fields: readonly F[],
  issues: { path: string; message: string }[],
): { field: F; direction: 'asc' | 'desc' } | undefined {
  if (value === undefined) return undefined;
  const [rawField, rawDirection] = value.split(':');
  const field = fields.find((candidate) => candidate === rawField);
  const direction =
    rawDirection === 'asc' || rawDirection === 'desc'
      ? rawDirection
      : undefined;
  if (field !== undefined && direction !== undefined) {
    return { field, direction };
  }
  issues.push({
    path: 'sort',
    message: `Invalid sort "${value}" (expected field:direction)`,
  });
  return undefined;
}

function parseTimeRange(
  start: string | undefined,
  end: string | undefined,
  issues: { path: string; message: string }[],
): { start: Date; end: Date } | undefined {
  if (start === undefined && end === undefined) return undefined;
  if (start === undefined || end === undefined) {
    issues.push({
      path: start === undefined ? 'start' : 'end',
      message: 'Both start and end are required for a time range',
    });
    return undefined;
  }
  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) {
    issues.push({ path: 'start', message: `Invalid start "${start}"` });
    return undefined;
  }
  const endDate = new Date(end);
  if (Number.isNaN(endDate.getTime())) {
    issues.push({ path: 'end', message: `Invalid end "${end}"` });
    return undefined;
  }
  return { start: startDate, end: endDate };
}

function parseLimit(
  value: string | undefined,
  issues: { path: string; message: string }[],
): number | undefined {
  if (value === undefined) return undefined;
  const limit = Number.parseInt(value, 10);
  if (!Number.isInteger(limit) || limit <= 0) {
    issues.push({
      path: 'limit',
      message: `Invalid limit "${value}" (expected a positive integer)`,
    });
    return undefined;
  }
  return limit;
}
