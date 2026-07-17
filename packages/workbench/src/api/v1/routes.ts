import {
  createScheduleRequestSchema,
  enqueueRequestSchema,
  updateScheduleRequestSchema,
} from '@openqueue/client/wire';
import type {
  CancelRunResult,
  EnqueueMeta,
  EnqueueOptions,
  EnqueueResult,
  Principal,
  QueueCatalogStore,
  QueueRunsApi,
  QueueSchedule,
  QueueSchedulesApi,
  TaskDefinition,
} from '@openqueue/core';
import { UnsupportedCapabilityError } from '@openqueue/core/world';
import { ZodError, type z } from 'zod';
import { errorMessage } from '../../util';
import type { HandlerResult, RouteDef } from '../handlers';
import type { ControlAuthConfig } from './auth';
import { canAccess, scopeMetaFilter, stampMeta } from './principal';
import {
  controlError,
  toEnqueueOptions,
  toRunListOptions,
  toScheduleListOptions,
  wireCatalogEntry,
  wireRun,
  wireSchedule,
} from './serialize';

export interface ControlRuntime {
  trigger<I, O = unknown>(
    id: string | TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  runs: QueueRunsApi;
  schedules: QueueSchedulesApi;
  catalog: Pick<QueueCatalogStore, 'read' | 'resolve'>;
}

export interface ControlApiOptions {
  /** `QueueWorkerRuntime` is structurally assignable. */
  runtime: ControlRuntime;
  auth: ControlAuthConfig;
  info: { namespace: string };
}

export function buildControlRouteTable(options: ControlApiOptions): RouteDef[] {
  const { runtime, info } = options;

  return [
    {
      method: 'get',
      path: '/health',
      handler: async () => ({ status: 200, body: { ok: true } }),
    },
    {
      method: 'get',
      path: '/info',
      handler: async () => {
        const catalog = await runtime.catalog.read();
        return {
          status: 200,
          body: {
            service: 'openqueue',
            apiVersion: 1,
            namespace: info.namespace,
            tasks: catalog.length,
            queues: sortedUnique(catalog.map((entry) => entry.queue)),
          },
        };
      },
    },
    {
      method: 'post',
      path: '/jobs',
      meta: { body: enqueueRequestSchema },
      handler: async (input) => {
        const parsed = parseBody(input.body, enqueueRequestSchema);
        if (!parsed.ok) return parsed.response;
        const { task } = parsed.data;
        const entry = await runtime.catalog.resolve(task);
        if (!entry) {
          return controlError('task_not_found', `Unknown task "${task}"`);
        }
        const opts = toEnqueueOptions(parsed.data.options);
        const meta = stampMeta(opts?.meta, input.principal);
        try {
          const result = await runtime.trigger(
            task,
            parsed.data.input,
            withMeta(opts, meta),
          );
          return { status: 201, body: result };
        } catch (err) {
          return triggerError(err);
        }
      },
    },
    {
      method: 'get',
      path: '/runs',
      handler: async (input) => {
        const parsed = toRunListOptions(input.query);
        if (!parsed.ok) {
          return controlError(
            'invalid_request',
            'Invalid query',
            parsed.issues,
          );
        }
        const result = await runtime.runs.list({
          ...parsed.options,
          meta: scopeMetaFilter(input.principal, parsed.options.meta),
        });
        return {
          status: 200,
          body: {
            data: result.data.map(wireRun),
            cursor: result.cursor,
            hasMore: result.hasMore,
          },
        };
      },
    },
    {
      method: 'get',
      path: '/runs/:id',
      handler: async (input) => {
        const id = input.params.id!;
        const run = await runtime.runs.retrieve(id);
        if (!run) return controlError('run_not_found', `Run "${id}" not found`);
        if (!canAccess(input.principal, run.meta)) return forbidden();
        return { status: 200, body: wireRun(run) };
      },
    },
    {
      method: 'post',
      path: '/runs/:id/cancel',
      handler: async (input) => {
        const id = input.params.id!;
        const existing = await runtime.runs.retrieve(id);
        if (!existing) {
          return controlError('run_not_found', `Run "${id}" not found`);
        }
        if (!canAccess(input.principal, existing.meta)) return forbidden();
        let result: CancelRunResult;
        try {
          result = await runtime.runs.cancel(id);
        } catch (err) {
          if (err instanceof UnsupportedCapabilityError) {
            return controlError('unsupported_capability', err.message);
          }
          throw err;
        }
        if (result.outcome === 'not_found') {
          return controlError('run_not_found', `Run "${id}" not found`);
        }
        if (result.outcome === 'canceled') {
          return {
            status: 200,
            body: { outcome: 'canceled', run: wireRun(result.run) },
          };
        }
        if (result.outcome === 'already_finished') {
          return {
            status: 409,
            body: { outcome: 'already_finished', run: wireRun(result.run) },
          };
        }
        return {
          status: 409,
          body: {
            outcome: 'not_cancelable',
            run: wireRun(result.run),
            reason: result.reason,
          },
        };
      },
    },
    {
      method: 'get',
      path: '/schedules',
      handler: async (input) => {
        const parsed = toScheduleListOptions(input.query);
        if (!parsed.ok) {
          return controlError(
            'invalid_request',
            'Invalid query',
            parsed.issues,
          );
        }
        const schedules = await runtime.schedules.list({
          ...parsed.options,
          meta: scopeMetaFilter(input.principal, parsed.options.meta),
        });
        return { status: 200, body: schedules.map(wireSchedule) };
      },
    },
    {
      method: 'post',
      path: '/schedules',
      meta: { body: createScheduleRequestSchema },
      handler: async (input) => {
        const parsed = parseBody(input.body, createScheduleRequestSchema);
        if (!parsed.ok) return parsed.response;
        const meta = stampMeta(parsed.data.meta, input.principal);
        const schedule = await runtime.schedules.create({
          ...parsed.data,
          meta,
        });
        return { status: 201, body: wireSchedule(schedule) };
      },
    },
    {
      method: 'get',
      path: '/schedules/:id',
      handler: async (input) => {
        const owned = await loadOwnedSchedule(
          runtime,
          input.params.id!,
          input.principal,
        );
        if (!owned.ok) return owned.response;
        return { status: 200, body: wireSchedule(owned.schedule) };
      },
    },
    {
      method: 'patch',
      path: '/schedules/:id',
      meta: { body: updateScheduleRequestSchema },
      handler: async (input) => {
        const parsed = parseBody(input.body, updateScheduleRequestSchema);
        if (!parsed.ok) return parsed.response;
        const id = input.params.id!;
        const owned = await loadOwnedSchedule(runtime, id, input.principal);
        if (!owned.ok) return owned.response;
        const meta = reownMeta(parsed.data.meta, owned.schedule.meta);
        try {
          const schedule = await runtime.schedules.update(id, {
            ...parsed.data,
            meta,
          });
          return { status: 200, body: wireSchedule(schedule) };
        } catch (err) {
          return scheduleError(err, id);
        }
      },
    },
    {
      method: 'delete',
      path: '/schedules/:id',
      handler: async (input) => {
        const id = input.params.id!;
        const owned = await loadOwnedSchedule(runtime, id, input.principal);
        if (!owned.ok) return owned.response;
        const deleted = await runtime.schedules.delete(id);
        if (!deleted) {
          return controlError(
            'schedule_not_found',
            `Schedule "${id}" not found`,
          );
        }
        return { status: 200, body: { deleted: true } };
      },
    },
    {
      method: 'post',
      path: '/schedules/:id/run',
      handler: async (input) => {
        const id = input.params.id!;
        const owned = await loadOwnedSchedule(runtime, id, input.principal);
        if (!owned.ok) return owned.response;
        try {
          const result = await runtime.schedules.runNow(id);
          return { status: 200, body: result };
        } catch (err) {
          return scheduleError(err, id);
        }
      },
    },
    {
      method: 'post',
      path: '/schedules/:id/activate',
      handler: async (input) => {
        const id = input.params.id!;
        const owned = await loadOwnedSchedule(runtime, id, input.principal);
        if (!owned.ok) return owned.response;
        try {
          const schedule = await runtime.schedules.activate(id);
          return { status: 200, body: wireSchedule(schedule) };
        } catch (err) {
          return scheduleError(err, id);
        }
      },
    },
    {
      method: 'post',
      path: '/schedules/:id/deactivate',
      handler: async (input) => {
        const id = input.params.id!;
        const owned = await loadOwnedSchedule(runtime, id, input.principal);
        if (!owned.ok) return owned.response;
        try {
          const schedule = await runtime.schedules.deactivate(id);
          return { status: 200, body: wireSchedule(schedule) };
        } catch (err) {
          return scheduleError(err, id);
        }
      },
    },
    {
      method: 'get',
      path: '/catalog',
      handler: async () => {
        const catalog = await runtime.catalog.read();
        return {
          status: 200,
          body: { tasks: catalog.map(wireCatalogEntry) },
        };
      },
    },
  ];
}

type OwnedSchedule =
  | { ok: true; schedule: QueueSchedule }
  | { ok: false; response: HandlerResult };

async function loadOwnedSchedule(
  runtime: ControlRuntime,
  id: string,
  principal: Principal | undefined,
): Promise<OwnedSchedule> {
  let schedule: QueueSchedule;
  try {
    schedule = await runtime.schedules.retrieve(id);
  } catch (err) {
    return { ok: false, response: scheduleError(err, id) };
  }
  if (!canAccess(principal, schedule.meta)) {
    return { ok: false, response: forbidden() };
  }
  return { ok: true, schedule };
}

function withMeta(
  opts: EnqueueOptions | undefined,
  meta: EnqueueMeta | undefined,
): EnqueueOptions | undefined {
  if (meta === undefined) return opts;
  return { ...opts, meta };
}

/**
 * Owner is immutable: strip any inbound `enqueuedBy` from the caller's update
 * and re-attach the schedule's original stamp. `undefined` incoming meta means
 * meta is not being updated.
 */
function reownMeta(
  incoming: EnqueueMeta | undefined,
  existing: EnqueueMeta,
): EnqueueMeta | undefined {
  const stripped = stampMeta(incoming, undefined);
  if (stripped === undefined) return undefined;
  if (existing.enqueuedBy !== undefined) {
    return { ...stripped, enqueuedBy: existing.enqueuedBy };
  }
  return stripped;
}

function forbidden(): HandlerResult {
  return controlError('forbidden', 'Forbidden');
}

function parseBody<T>(
  body: unknown,
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false; response: HandlerResult } {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    response: controlError(
      'invalid_request',
      'Invalid request body',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    ),
  };
}

function triggerError(err: unknown): HandlerResult {
  if (err instanceof UnsupportedCapabilityError) {
    return controlError('unsupported_capability', err.message);
  }
  if (err instanceof ZodError) {
    return controlError(
      'invalid_request',
      'Invalid task input',
      err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return controlError('internal', errorMessage(err));
}

function scheduleError(err: unknown, id: string): HandlerResult {
  if (err instanceof UnsupportedCapabilityError) {
    return controlError('unsupported_capability', err.message);
  }
  if (
    err instanceof Error &&
    err.message.startsWith('Unknown queue schedule')
  ) {
    return controlError('schedule_not_found', `Schedule "${id}" not found`);
  }
  return controlError('internal', errorMessage(err));
}

function sortedUnique(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}
