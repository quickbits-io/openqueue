import { type ClientAuth, createHttp, type FetchLike } from './http';
import type {
  CancelRunResult,
  CreateScheduleOptions,
  EnqueueOptions,
  EnqueueResult,
  QueueCatalogEntry,
  QueueRun,
  QueueRunListOptions,
  QueueRunListResult,
  QueueRunPollOptions,
  QueueSchedule,
  QueueScheduleListOptions,
  RunStatus,
  TaskRef,
  UpdateScheduleOptions,
  WorkerInfo,
} from './types';
import {
  cancelRunResponseSchema,
  catalogResponseSchema,
  enqueueResultSchema,
  healthResponseSchema,
  infoResponseSchema,
  scheduleDeletedResponseSchema,
  type WireCreateScheduleRequest,
  type WireEnqueueOptions,
  type WireRun,
  type WireSchedule,
  type WireUpdateScheduleRequest,
  wireRunListSchema,
  wireRunSchema,
  wireScheduleListSchema,
  wireScheduleSchema,
} from './wire';

export interface ClientOptions {
  /** Absolute origin (server-to-server) or same-origin prefix (behind a proxy). */
  host: string;
  auth?: ClientAuth;
  /** Custom fetch (tests, instrumented runtimes). Defaults to globalThis.fetch. */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
}

export interface OpenQueueClient {
  catalog: {
    read(): Promise<QueueCatalogEntry[]>;
    resolve(id: string): Promise<QueueCatalogEntry | undefined>;
  };
  trigger<I, O = unknown>(
    target: string | TaskRef<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  runs: {
    list(options?: QueueRunListOptions): Promise<QueueRunListResult>;
    retrieve(id: string): Promise<QueueRun | undefined>;
    poll(id: string, options?: QueueRunPollOptions): Promise<QueueRun>;
    cancel(id: string): Promise<CancelRunResult>;
  };
  schedules: {
    create(options: CreateScheduleOptions): Promise<QueueSchedule>;
    retrieve(id: string): Promise<QueueSchedule>;
    list(options?: QueueScheduleListOptions): Promise<QueueSchedule[]>;
    runNow(id: string): Promise<EnqueueResult>;
    update(id: string, options: UpdateScheduleOptions): Promise<QueueSchedule>;
    activate(id: string): Promise<QueueSchedule>;
    deactivate(id: string): Promise<QueueSchedule>;
    delete(id: string): Promise<boolean>;
    timezones(): Promise<string[]>;
  };
  health(): Promise<{ ok: boolean }>;
  info(): Promise<WorkerInfo>;
  close(): Promise<void>;
}

const defaultPollIntervalMs = 1000;
const defaultPollMaxAttempts = 500;
const terminalRunStatuses = new Set<RunStatus>([
  'completed',
  'failed',
  'canceled',
  'timed_out',
  'expired',
]);

export function createClient(options: ClientOptions): OpenQueueClient {
  const http = createHttp({
    host: options.host,
    auth: options.auth,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });

  const runs: OpenQueueClient['runs'] = {
    list: async (listOptions) => {
      const { data } = await http.request({
        method: 'GET',
        path: '/runs',
        query: runListQuery(listOptions),
        schema: wireRunListSchema,
      });
      return {
        data: data.data.map(toRun),
        cursor: data.cursor,
        hasMore: data.hasMore,
      };
    },
    retrieve: async (id) => {
      const { data } = await http.requestOrStatus({
        method: 'GET',
        path: `/runs/${encodeURIComponent(id)}`,
        schema: wireRunSchema,
        expect: [200, 404],
      });
      return data ? toRun(data) : undefined;
    },
    poll: async (id, pollOptions) => {
      const maxAttempts = pollOptions?.maxAttempts ?? defaultPollMaxAttempts;
      const interval = pollOptions?.pollIntervalMs ?? defaultPollIntervalMs;
      for (let attempt = 0; attempt++ < maxAttempts; ) {
        const run = await runs.retrieve(id);
        if (run && terminalRunStatuses.has(run.status)) return run;
        await sleep(interval);
      }
      throw new Error(
        `Run ${id} did not complete after ${maxAttempts} attempts`,
      );
    },
    cancel: async (id) => {
      const { data } = await http.requestOrStatus({
        method: 'POST',
        path: `/runs/${encodeURIComponent(id)}/cancel`,
        schema: cancelRunResponseSchema,
        expect: [200, 409, 404],
      });
      if (!data) return { outcome: 'not_found' };
      if (data.outcome === 'canceled') {
        return { outcome: 'canceled', run: toRun(data.run) };
      }
      if (data.outcome === 'already_finished') {
        return { outcome: 'already_finished', run: toRun(data.run) };
      }
      return {
        outcome: 'not_cancelable',
        run: toRun(data.run),
        reason: 'executing',
      };
    },
  };

  const schedules: OpenQueueClient['schedules'] = {
    create: async (createOptions) => {
      const { data } = await http.request({
        method: 'POST',
        path: '/schedules',
        body: toCreateScheduleBody(createOptions),
        schema: wireScheduleSchema,
      });
      return toSchedule(data);
    },
    retrieve: async (id) => {
      const { data } = await http.request({
        method: 'GET',
        path: `/schedules/${encodeURIComponent(id)}`,
        schema: wireScheduleSchema,
      });
      return toSchedule(data);
    },
    list: async (listOptions) => {
      const { data } = await http.request({
        method: 'GET',
        path: '/schedules',
        query: scheduleListQuery(listOptions),
        schema: wireScheduleListSchema,
      });
      return data.map(toSchedule);
    },
    runNow: async (id) => {
      const { data } = await http.request({
        method: 'POST',
        path: `/schedules/${encodeURIComponent(id)}/run`,
        schema: enqueueResultSchema,
      });
      return data;
    },
    update: async (id, updateOptions) => {
      const { data } = await http.request({
        method: 'PATCH',
        path: `/schedules/${encodeURIComponent(id)}`,
        body: toUpdateScheduleBody(updateOptions),
        schema: wireScheduleSchema,
      });
      return toSchedule(data);
    },
    activate: async (id) => {
      const { data } = await http.request({
        method: 'POST',
        path: `/schedules/${encodeURIComponent(id)}/activate`,
        schema: wireScheduleSchema,
      });
      return toSchedule(data);
    },
    deactivate: async (id) => {
      const { data } = await http.request({
        method: 'POST',
        path: `/schedules/${encodeURIComponent(id)}/deactivate`,
        schema: wireScheduleSchema,
      });
      return toSchedule(data);
    },
    delete: async (id) => {
      const { data } = await http.requestOrStatus({
        method: 'DELETE',
        path: `/schedules/${encodeURIComponent(id)}`,
        schema: scheduleDeletedResponseSchema,
        expect: [200, 404],
      });
      return data?.deleted ?? false;
    },
    timezones: async () => {
      const intl: { supportedValuesOf?: (value: 'timeZone') => string[] } =
        Intl;
      return ['UTC', ...(intl.supportedValuesOf?.('timeZone') ?? [])];
    },
  };

  return {
    catalog: {
      read: async () => {
        const { data } = await http.request({
          method: 'GET',
          path: '/catalog',
          schema: catalogResponseSchema,
        });
        return data.tasks;
      },
      resolve: async (id) => {
        const { data } = await http.request({
          method: 'GET',
          path: '/catalog',
          schema: catalogResponseSchema,
        });
        return data.tasks.find((entry) => entry.id === id);
      },
    },
    trigger: async (target, input, opts) => {
      const id = typeof target === 'string' ? target : target.id;
      const parsedInput =
        typeof target !== 'string' && target.schema
          ? target.schema.parse(input)
          : input;
      const { data } = await http.request({
        method: 'POST',
        path: '/jobs',
        body: { task: id, input: parsedInput, options: toWireOptions(opts) },
        schema: enqueueResultSchema,
      });
      return data;
    },
    runs,
    schedules,
    health: async () => {
      const { data } = await http.request({
        method: 'GET',
        path: '/health',
        schema: healthResponseSchema,
      });
      return data;
    },
    info: async () => {
      const { data } = await http.request({
        method: 'GET',
        path: '/info',
        schema: infoResponseSchema,
      });
      return data;
    },
    close: async () => undefined,
  };
}

function toRun(wire: WireRun): QueueRun {
  return {
    id: wire.id,
    transportJobId: wire.transportJobId,
    task: wire.task,
    queue: wire.queue,
    status: wire.status,
    input: wire.input,
    output: wire.output,
    error: wire.error,
    meta: wire.meta,
    metadata: wire.metadata,
    tags: wire.tags,
    scheduleId: wire.scheduleId,
    scheduleExternalId: wire.scheduleExternalId,
    createdAt: new Date(wire.createdAt),
    startedAt: wire.startedAt ? new Date(wire.startedAt) : undefined,
    finishedAt: wire.finishedAt ? new Date(wire.finishedAt) : undefined,
    updatedAt: new Date(wire.updatedAt),
  };
}

function toSchedule(wire: WireSchedule): QueueSchedule {
  return {
    id: wire.id,
    type: wire.type,
    task: wire.task,
    input: wire.input,
    active: wire.active,
    cron: wire.cron,
    timezone: wire.timezone,
    externalId: wire.externalId,
    deduplicationKey: wire.deduplicationKey,
    meta: wire.meta,
    nextRun: wire.nextRun ? new Date(wire.nextRun) : undefined,
    lastRun: wire.lastRun ? new Date(wire.lastRun) : undefined,
    createdAt: new Date(wire.createdAt),
    updatedAt: new Date(wire.updatedAt),
  };
}

function toWireOptions(
  opts: EnqueueOptions | undefined,
): WireEnqueueOptions | undefined {
  if (!opts) return undefined;
  return {
    runId: opts.runId,
    jobId: opts.jobId,
    delay: opts.delay,
    priority: opts.priority,
    attempts: opts.attempts,
    backoff: opts.backoff,
    meta: opts.meta,
  };
}

function toCreateScheduleBody(
  options: CreateScheduleOptions,
): WireCreateScheduleRequest {
  return {
    task: typeof options.task === 'string' ? options.task : options.task.id,
    input: options.input,
    cron: options.cron,
    timezone: options.timezone,
    externalId: options.externalId,
    deduplicationKey: options.deduplicationKey,
    meta: options.meta,
  };
}

function toUpdateScheduleBody(
  options: UpdateScheduleOptions,
): WireUpdateScheduleRequest {
  return {
    task:
      options.task === undefined
        ? undefined
        : typeof options.task === 'string'
          ? options.task
          : options.task.id,
    input: options.input,
    cron: options.cron,
    timezone: options.timezone,
    externalId: options.externalId,
    deduplicationKey: options.deduplicationKey,
    meta: options.meta,
  };
}

function runListQuery(
  options: QueueRunListOptions | undefined,
): Record<string, string | undefined> {
  if (!options) return {};
  return {
    id: options.id,
    task: options.task,
    status: options.status,
    scheduleId: options.scheduleId,
    scheduleExternalId: options.scheduleExternalId,
    meta: options.meta ? JSON.stringify(options.meta) : undefined,
    start: options.timeRange?.start.toISOString(),
    end: options.timeRange?.end.toISOString(),
    sort: options.sort
      ? `${options.sort.field}:${options.sort.direction}`
      : undefined,
    limit: options.limit === undefined ? undefined : String(options.limit),
    cursor: options.cursor,
  };
}

function scheduleListQuery(
  options: QueueScheduleListOptions | undefined,
): Record<string, string | undefined> {
  if (!options) return {};
  return {
    task: options.task,
    externalId: options.externalId,
    active: options.active === undefined ? undefined : String(options.active),
    meta: options.meta ? JSON.stringify(options.meta) : undefined,
    sort: options.sort
      ? `${options.sort.field}:${options.sort.direction}`
      : undefined,
    limit: options.limit === undefined ? undefined : String(options.limit),
    cursor: options.cursor,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
