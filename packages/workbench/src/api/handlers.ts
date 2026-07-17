import type { Principal, QueueRunSpan } from '@openqueue/core';
import { z } from 'zod';
import { validateContactPointUrl } from '../core/alert-destinations';
import { toPublicContactPoint } from '../core/alert-store';
import type {
  DynamicScheduleInfo,
  JobStatus,
  RunSpanInfo,
  SortOptions,
  WorkbenchDynamicSchedule,
  WorkbenchScheduleListOptions,
} from '../core/types';
import type { WorkbenchCore } from '../core/workbench';
import { errorMessage, isRecord, safeJsonParse } from '../util';
import {
  activityStatsResponseSchema,
  alertContactPointPublicSchema,
  alertDeliveryRecordSchema,
  alertEventSchema,
  alertRuleSchema,
  alertRuntimeStatusSchema,
  bulkJobsSchema,
  cleanJobsSchema,
  cleanResultSchema,
  contactPointCreateSchema,
  contactPointUpdateSchema,
  createFlowRequestSchema,
  createFlowResponseSchema,
  dynamicScheduleInfoSchema,
  errorsResponseSchema,
  flowNodeSchema,
  flowParam,
  flowsListResponseSchema,
  idParam,
  idResponseSchema,
  jobInfoSchema,
  jobLogsQuerySchema,
  jobLogsResponseSchema,
  jobParam,
  jobSpansResponseSchema,
  limitQuerySchema,
  metricsResponseSchema,
  overviewStatsSchema,
  paginated,
  queueInfoSchema,
  queueJobsQuerySchema,
  queueNameParam,
  queuePausedResponseSchema,
  ruleCreateSchema,
  ruleUpdateSchema,
  runInfoListSchema,
  runsQuerySchema,
  schedulerDetailSchema,
  schedulerParam,
  schedulersQuerySchema,
  searchQuerySchema,
  searchResponseSchema,
  successResponseSchema,
  tagFieldParam,
  tagValuesResponseSchema,
  testJobRequestSchema,
  testJobResponseSchema,
} from './schemas';

/**
 * Framework-agnostic HTTP method.
 */
export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * Normalized input passed to every handler. Adapters are responsible for
 * mapping their framework-specific request shape to this.
 */
export interface HandlerInput {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body?: unknown;
  /** Verified caller, when the mounting app ran an auth walk. */
  principal?: Principal;
}

/**
 * Normalized output returned by every handler. Adapters serialize this
 * onto their framework-specific response object.
 */
export interface HandlerResult {
  status: number;
  body: unknown;
}

/**
 * A framework-agnostic route handler. Closes over a `WorkbenchCore` and
 * takes a normalized request envelope.
 */
export type Handler = (input: HandlerInput) => Promise<HandlerResult>;

/**
 * OpenAPI metadata for a route. Schemas double as the source of truth for
 * runtime validation (request `body`) and the generated OpenAPI document.
 */
export interface RouteMeta {
  summary?: string;
  tags?: string[];
  /** Path params — must be an object schema so param names can be extracted. */
  params?: z.ZodObject;
  /** Query params — must be an object schema. */
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Success response body schema. */
  response?: z.ZodType;
  /** Success status code (defaults to 200). */
  status?: number;
}

/**
 * A framework-agnostic route definition.
 *
 * `path` uses `:param` syntax compatible with Hono, Express, and Fastify.
 * Paths are relative to `/api` — adapters mount them under that prefix.
 */
export interface RouteDef {
  method: HttpMethod;
  path: string;
  handler: Handler;
  meta?: RouteMeta;
}

/**
 * Validate a request body against a schema. On success returns the typed data;
 * on failure returns a 400 response with the validation issues.
 */
function parseBody<T>(
  body: unknown,
  schema: z.ZodType<T>,
): { ok: true; data: T } | { ok: false; response: HandlerResult } {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    response: {
      status: 400,
      body: {
        error: 'Invalid request body',
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    },
  };
}

/**
 * Parse sort query param in format "field:direction" (e.g., "timestamp:desc")
 * Defaults to desc if direction not specified.
 */
function parseSort(sort?: string): SortOptions | undefined {
  if (!sort) return undefined;
  const [field, dir] = sort.split(':');
  if (!field) return undefined;
  return {
    field,
    direction: dir === 'asc' ? 'asc' : 'desc',
  };
}

const SCHEDULE_SORT_FIELDS = [
  'nextRun',
  'lastRun',
  'createdAt',
  'updatedAt',
] as const satisfies readonly NonNullable<
  WorkbenchScheduleListOptions['sort']
>['field'][];
const SCHEDULE_SORT_FIELD_SET = new Set<string>(SCHEDULE_SORT_FIELDS);
function isScheduleSortField(
  value: string,
): value is (typeof SCHEDULE_SORT_FIELDS)[number] {
  return SCHEDULE_SORT_FIELD_SET.has(value);
}

const JOB_STATUSES = [
  'active',
  'waiting',
  'waiting-children',
  'prioritized',
  'completed',
  'failed',
  'delayed',
  'paused',
  'unknown',
] as const satisfies readonly JobStatus[];
const JOB_STATUS_SET = new Set<string>(JOB_STATUSES);
function isJobStatus(value: string): value is JobStatus {
  return JOB_STATUS_SET.has(value);
}

const readonlyError = {
  status: 403 as const,
  body: { error: 'Dashboard is in readonly mode' },
};

const storageError = {
  status: 501 as const,
  body: { error: 'Queue runtime is not configured' },
};

function validationIssues(error: unknown) {
  const issues = isRecord(error) ? error.issues : undefined;
  if (!Array.isArray(issues)) return undefined;

  return issues.map((issue) => ({
    path:
      isRecord(issue) && Array.isArray(issue.path) ? issue.path.join('.') : '',
    message:
      isRecord(issue) && typeof issue.message === 'string'
        ? issue.message
        : 'Invalid value',
  }));
}

function dynamicScheduleInfo(
  schedule: WorkbenchDynamicSchedule,
): DynamicScheduleInfo {
  return {
    id: schedule.id,
    type: schedule.type,
    task: schedule.task,
    active: schedule.active,
    cron: schedule.cron,
    timezone: schedule.timezone,
    externalId: schedule.externalId,
    deduplicationKey: schedule.deduplicationKey,
    meta: schedule.meta,
    nextRun: schedule.nextRun?.getTime(),
    lastRun: schedule.lastRun?.getTime(),
    createdAt: schedule.createdAt.getTime(),
    updatedAt: schedule.updatedAt.getTime(),
  };
}

function spanInfo(span: QueueRunSpan): RunSpanInfo {
  return {
    id: span.id,
    attempt: span.attempt,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    kind: span.kind,
    name: span.name,
    level: span.level,
    status: span.status,
    error: span.error,
    startedAt: span.startedAt.getTime(),
    durationMs: span.durationMs,
    attributes: span.attributes,
  };
}

function parseDynamicScheduleOptions(
  query: Record<string, string | undefined>,
): WorkbenchScheduleListOptions {
  const sort = parseSort(query.dynamicSort);
  const active =
    query.active === 'true'
      ? true
      : query.active === 'false'
        ? false
        : undefined;
  return {
    task: query.task,
    externalId: query.externalId,
    active,
    meta: parseJsonRecord(query.meta),
    sort:
      sort && isScheduleSortField(sort.field)
        ? {
            field: sort.field,
            direction: sort.direction,
          }
        : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    cursor: query.cursor,
  };
}

function parseJsonRecord(
  value: string | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const parsed = safeJsonParse(value);
  return isRecord(parsed) && !Array.isArray(parsed) ? parsed : undefined;
}

function alertsRoutes(core: WorkbenchCore): RouteDef[] {
  const am = core.alertManager;
  if (!am) return [];

  const store = am.getStore();
  const isReadonly = () => !!core.options.readonly;

  return [
    {
      method: 'get',
      path: '/alerts/status',
      meta: {
        summary: 'Get alerting runtime status',
        tags: ['Alerts'],
        response: alertRuntimeStatusSchema,
      },
      handler: async () => ({
        status: 200,
        body: await am.getStatus(),
      }),
    },
    {
      method: 'get',
      path: '/alerts/contact-points',
      meta: {
        summary: 'List contact points',
        tags: ['Alerts'],
        response: z.array(alertContactPointPublicSchema),
      },
      handler: async () => {
        const points = await store.getContactPoints();
        return {
          status: 200,
          body: points.map(toPublicContactPoint),
        };
      },
    },
    {
      method: 'post',
      path: '/alerts/contact-points',
      meta: {
        summary: 'Create a contact point',
        tags: ['Alerts'],
        body: contactPointCreateSchema,
        response: alertContactPointPublicSchema,
        status: 201,
      },
      handler: async ({ body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, contactPointCreateSchema);
        if (!parsed.ok) return parsed.response;
        const input = parsed.data;
        const urlError = validateContactPointUrl(input.preset, input.url);
        if (urlError) {
          return { status: 400, body: { error: urlError } };
        }
        const created = await store.createContactPoint({
          name: input.name,
          preset: input.preset,
          url: input.url,
          enabled: input.enabled ?? true,
          displayName: input.displayName,
          iconUrl: input.iconUrl,
          headers: input.headers,
        });
        return { status: 201, body: toPublicContactPoint(created) };
      },
    },
    {
      method: 'put',
      path: '/alerts/contact-points/:id',
      meta: {
        summary: 'Update a contact point',
        tags: ['Alerts'],
        params: idParam,
        body: contactPointUpdateSchema,
        response: alertContactPointPublicSchema,
      },
      handler: async ({ params, body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, contactPointUpdateSchema);
        if (!parsed.ok) return parsed.response;
        const input = parsed.data;
        if (input?.url && input.preset) {
          const urlError = validateContactPointUrl(input.preset, input.url);
          if (urlError) {
            return { status: 400, body: { error: urlError } };
          }
        } else if (input?.url) {
          const existing = await store.getContactPoint(params.id!);
          if (existing) {
            const urlError = validateContactPointUrl(
              existing.preset,
              input.url,
            );
            if (urlError) {
              return { status: 400, body: { error: urlError } };
            }
          }
        }
        const updated = await store.updateContactPoint(params.id!, {
          name: input?.name,
          preset: input?.preset,
          url: input?.url,
          enabled: input?.enabled,
          displayName: input?.displayName,
          iconUrl: input?.iconUrl,
          headers: input?.headers,
        });
        if (!updated) {
          return { status: 404, body: { error: 'Contact point not found' } };
        }
        return { status: 200, body: toPublicContactPoint(updated) };
      },
    },
    {
      method: 'delete',
      path: '/alerts/contact-points/:id',
      meta: {
        summary: 'Delete a contact point',
        tags: ['Alerts'],
        params: idParam,
        response: successResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const ok = await store.deleteContactPoint(params.id!);
        if (!ok) {
          return { status: 404, body: { error: 'Contact point not found' } };
        }
        return { status: 200, body: { success: true } };
      },
    },
    {
      method: 'post',
      path: '/alerts/contact-points/:id/test',
      meta: {
        summary: 'Send a test notification to a contact point',
        tags: ['Alerts'],
        params: idParam,
        response: alertDeliveryRecordSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const record = await am.sendTest(params.id!);
        return { status: 200, body: record };
      },
    },
    {
      method: 'get',
      path: '/alerts/rules',
      meta: {
        summary: 'List alert rules',
        tags: ['Alerts'],
        response: z.array(alertRuleSchema),
      },
      handler: async () => ({
        status: 200,
        body: await store.getRules(),
      }),
    },
    {
      method: 'post',
      path: '/alerts/rules',
      meta: {
        summary: 'Create an alert rule',
        tags: ['Alerts'],
        body: ruleCreateSchema,
        response: alertRuleSchema,
        status: 201,
      },
      handler: async ({ body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, ruleCreateSchema);
        if (!parsed.ok) return parsed.response;
        const input = parsed.data;
        const created = await store.createRule({
          name: input.name,
          enabled: input.enabled ?? true,
          trigger: input.trigger,
          severity: input.severity ?? 'warning',
          queues: input.queues,
          jobNames: input.jobNames,
          threshold: input.threshold,
          contactPointIds: input.contactPointIds,
          cooldownMs: input.cooldownMs,
        });
        return { status: 201, body: created };
      },
    },
    {
      method: 'put',
      path: '/alerts/rules/:id',
      meta: {
        summary: 'Update an alert rule',
        tags: ['Alerts'],
        params: idParam,
        body: ruleUpdateSchema,
        response: alertRuleSchema,
      },
      handler: async ({ params, body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, ruleUpdateSchema);
        if (!parsed.ok) return parsed.response;
        const input = parsed.data;
        const updated = await store.updateRule(params.id!, {
          name: input?.name,
          enabled: input?.enabled,
          trigger: input?.trigger,
          severity: input?.severity,
          queues: input?.queues,
          jobNames: input?.jobNames,
          threshold: input?.threshold,
          contactPointIds: input?.contactPointIds,
          cooldownMs: input?.cooldownMs,
        });
        if (!updated) {
          return { status: 404, body: { error: 'Rule not found' } };
        }
        return { status: 200, body: updated };
      },
    },
    {
      method: 'delete',
      path: '/alerts/rules/:id',
      meta: {
        summary: 'Delete an alert rule',
        tags: ['Alerts'],
        params: idParam,
        response: successResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const ok = await store.deleteRule(params.id!);
        if (!ok) {
          return { status: 404, body: { error: 'Rule not found' } };
        }
        return { status: 200, body: { success: true } };
      },
    },
    {
      method: 'post',
      path: '/alerts/rules/:id/preview',
      meta: {
        summary: 'Preview which events a rule would match',
        tags: ['Alerts'],
        params: idParam,
        response: z.array(alertEventSchema),
      },
      handler: async ({ params }) => {
        const rule = await store.getRule(params.id!);
        if (!rule) {
          return { status: 404, body: { error: 'Rule not found' } };
        }
        return { status: 200, body: am.previewRule(rule) };
      },
    },
  ];
}

/**
 * Build the framework-agnostic route table for the Workbench API.
 *
 * Adapters iterate this list and register each route on their host framework.
 * Paths are relative to `/api`.
 */
export function buildRouteTable(core: WorkbenchCore): RouteDef[] {
  const qm = core.queueManager;
  const isReadonly = () => !!core.options.readonly;

  return [
    {
      method: 'post',
      path: '/refresh',
      meta: {
        summary: 'Clear server-side caches',
        tags: ['Queues'],
        response: successResponseSchema,
      },
      handler: async () => {
        qm.clearCache();
        return { status: 200, body: { success: true } };
      },
    },

    {
      method: 'get',
      path: '/overview',
      meta: {
        summary: 'Dashboard overview stats',
        tags: ['Overview'],
        response: overviewStatsSchema,
      },
      handler: async () => ({
        status: 200,
        body: await qm.getOverview(),
      }),
    },

    {
      method: 'get',
      path: '/counts',
      meta: { summary: 'Quick job counts per queue', tags: ['Overview'] },
      handler: async () => ({
        status: 200,
        body: await qm.getQuickCounts(),
      }),
    },

    {
      method: 'get',
      path: '/runs',
      meta: {
        summary: 'List runs across queues with filters',
        tags: ['Runs'],
        query: runsQuerySchema,
        response: paginated(runInfoListSchema),
      },
      handler: async ({ query }) => {
        const limit = Number(query.limit) || 50;
        const cursor = query.cursor;
        const start = cursor ? Number(cursor) : 0;
        const sort = parseSort(query.sort);

        const status =
          query.status && isJobStatus(query.status) ? query.status : undefined;
        const q = query.q;
        const from = query.from;
        const to = query.to;
        const tagsParam = query.tags;

        let tags: Record<string, string> | undefined;
        if (tagsParam) {
          try {
            tags = JSON.parse(tagsParam);
          } catch {
            const tagPairs = tagsParam.split(',');
            tags = {};
            for (const pair of tagPairs) {
              const [key, value] = pair.split(':');
              if (key && value) {
                tags[key.trim()] = value.trim();
              }
            }
          }
        }

        let timeRange: { start: number; end: number } | undefined;
        if (from && to) {
          timeRange = {
            start: Number(from),
            end: Number(to),
          };
        }

        let text: string | undefined;
        if (q) {
          if (!q.includes(':')) {
            text = q;
          } else {
            const parts = q.split(' ');
            const textParts = parts.filter((p) => !p.includes(':'));
            if (textParts.length > 0) {
              text = textParts.join(' ');
            }
          }
        }

        const filters =
          status || tags || text || timeRange
            ? {
                status,
                tags,
                text,
                timeRange,
              }
            : undefined;

        return {
          status: 200,
          body: await qm.getAllRuns(limit, start, sort, filters),
        };
      },
    },

    {
      method: 'get',
      path: '/schedulers',
      meta: {
        summary: 'List repeatable, delayed, and dynamic schedulers',
        tags: ['Schedulers'],
        query: schedulersQuerySchema,
      },
      handler: async ({ query }) => {
        const repeatableSort = parseSort(query.repeatableSort);
        const delayedSort = parseSort(query.delayedSort);
        const dynamic = core.options.queue?.schedules
          ? (
              await core.options.queue.schedules.list(
                parseDynamicScheduleOptions(query),
              )
            ).map(dynamicScheduleInfo)
          : [];
        const schedulers = await qm.getSchedulers(repeatableSort, delayedSort);
        return {
          status: 200,
          body: { ...schedulers, dynamic },
        };
      },
    },

    {
      method: 'post',
      path: '/test',
      meta: {
        summary: 'Enqueue a test job or flow',
        tags: ['Test'],
        body: testJobRequestSchema,
        response: testJobResponseSchema,
      },
      handler: async ({ body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, testJobRequestSchema);
        if (!parsed.ok) return parsed.response;
        const req = parsed.data;

        try {
          const result = await qm.enqueueJob(req);
          return { status: 200, body: result };
        } catch (e) {
          const issues = validationIssues(e);
          return {
            status: 400,
            body: {
              error: issues ? 'Invalid payload' : errorMessage(e),
              issues,
            },
          };
        }
      },
    },

    {
      method: 'get',
      path: '/queue-names',
      meta: {
        summary: 'List queue names',
        tags: ['Queues'],
        response: z.array(z.string()),
      },
      handler: async () => ({
        status: 200,
        body: qm.getQueueNames(),
      }),
    },

    {
      method: 'get',
      path: '/queues',
      meta: {
        summary: 'List queues with job counts',
        tags: ['Queues'],
        response: z.array(queueInfoSchema),
      },
      handler: async () => ({
        status: 200,
        body: await qm.getQueues(),
      }),
    },

    {
      method: 'get',
      path: '/metrics',
      meta: {
        summary: 'Throughput, latency, and failure metrics',
        tags: ['Metrics'],
        response: metricsResponseSchema,
      },
      handler: async () => ({
        status: 200,
        body: await qm.getMetrics(),
      }),
    },

    {
      method: 'get',
      path: '/errors',
      meta: {
        summary: 'Failed-job triage grouped by error class',
        tags: ['Metrics'],
        response: errorsResponseSchema,
      },
      handler: async () => {
        const metrics = await qm.getMetrics();
        return {
          status: 200,
          body: {
            groups: metrics.mostFailingTypes,
            buckets: metrics.aggregate.buckets,
            summary: metrics.aggregate.summary,
            computedAt: metrics.computedAt,
          },
        };
      },
    },

    {
      method: 'get',
      path: '/activity',
      meta: {
        summary: '7-day activity timeline',
        tags: ['Metrics'],
        response: activityStatsResponseSchema,
      },
      handler: async () => ({
        status: 200,
        body: await qm.getActivityStats(),
      }),
    },

    {
      method: 'get',
      path: '/queues/:name/jobs',
      meta: {
        summary: 'List jobs in a queue',
        tags: ['Queues'],
        params: queueNameParam,
        query: queueJobsQuerySchema,
        response: paginated(jobInfoSchema),
      },
      handler: async ({ params, query }) => {
        const name = params.name!;
        const status =
          query.status && isJobStatus(query.status) ? query.status : undefined;
        const limit = Number(query.limit) || 50;
        const cursor = query.cursor;
        const start = cursor ? Number(cursor) : 0;
        const sort = parseSort(query.sort);

        return {
          status: 200,
          body: await qm.getJobs(name, status, limit, start, sort),
        };
      },
    },

    {
      method: 'get',
      path: '/jobs/:queue/:id/logs',
      meta: {
        summary: 'Read a job’s logs',
        tags: ['Jobs'],
        params: jobParam,
        query: jobLogsQuerySchema,
        response: jobLogsResponseSchema,
      },
      handler: async ({ params, query }) => {
        const start = query.start !== undefined ? Number(query.start) : 0;
        const end = query.end !== undefined ? Number(query.end) : -1;
        const asc = query.asc !== 'false';

        const logs = await qm.getJobLogs(
          params.queue!,
          params.id!,
          start,
          end,
          asc,
        );
        if (!logs) {
          return { status: 404, body: { error: 'Job not found' } };
        }
        return { status: 200, body: logs };
      },
    },

    {
      method: 'get',
      path: '/jobs/:queue/:id/spans',
      meta: {
        summary: 'Read a run’s span/log timeline',
        tags: ['Jobs'],
        params: jobParam,
        response: jobSpansResponseSchema,
      },
      handler: async ({ params }) => {
        const spans = core.options.queue?.spans;
        if (!spans) return storageError;
        const job = await qm.getJob(params.queue!, params.id!);
        if (!job) {
          return { status: 404, body: { error: 'Job not found' } };
        }
        const runId =
          isRecord(job.data) && typeof job.data.__runId === 'string'
            ? job.data.__runId
            : job.id;
        const rows = await spans.listByRun(runId);
        return { status: 200, body: { spans: rows.map(spanInfo) } };
      },
    },

    {
      method: 'get',
      path: '/jobs/:queue/:id',
      meta: {
        summary: 'Get a single job',
        tags: ['Jobs'],
        params: jobParam,
        response: jobInfoSchema,
      },
      handler: async ({ params }) => {
        const job = await qm.getJob(params.queue!, params.id!);
        if (!job) {
          return { status: 404, body: { error: 'Job not found' } };
        }
        return { status: 200, body: job };
      },
    },

    {
      method: 'post',
      path: '/jobs/:queue/:id/retry',
      meta: {
        summary: 'Retry a job',
        tags: ['Jobs'],
        params: jobParam,
        response: successResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const success = await qm.retryJob(params.queue!, params.id!);
        if (!success) {
          return { status: 400, body: { error: 'Failed to retry job' } };
        }
        return { status: 200, body: { success: true } };
      },
    },

    {
      method: 'post',
      path: '/jobs/:queue/:id/remove',
      meta: {
        summary: 'Remove a job',
        tags: ['Jobs'],
        params: jobParam,
        response: successResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const success = await qm.removeJob(params.queue!, params.id!);
        if (!success) {
          return { status: 400, body: { error: 'Failed to remove job' } };
        }
        return { status: 200, body: { success: true } };
      },
    },

    {
      method: 'post',
      path: '/jobs/:queue/:id/promote',
      meta: {
        summary: 'Promote a delayed job',
        tags: ['Jobs'],
        params: jobParam,
        response: successResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const success = await qm.promoteJob(params.queue!, params.id!);
        if (!success) {
          return { status: 400, body: { error: 'Failed to promote job' } };
        }
        return { status: 200, body: { success: true } };
      },
    },

    {
      method: 'get',
      path: '/schedulers/:queue/:key',
      meta: {
        summary: 'Get scheduler detail',
        tags: ['Schedulers'],
        params: schedulerParam,
        response: schedulerDetailSchema,
      },
      handler: async ({ params }) => {
        const detail = await qm.getSchedulerDetail(params.queue!, params.key!);
        if (!detail) {
          return { status: 404, body: { error: 'Scheduler not found' } };
        }
        return { status: 200, body: detail };
      },
    },

    {
      method: 'post',
      path: '/schedulers/:queue/:key/run',
      meta: {
        summary: 'Run a scheduler now',
        tags: ['Schedulers'],
        params: schedulerParam,
        response: idResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const result = await qm.runSchedulerNow(params.queue!, params.key!);
        if (!result) {
          return { status: 400, body: { error: 'Failed to run scheduler' } };
        }
        return { status: 200, body: result };
      },
    },

    {
      method: 'get',
      path: '/schedules/:id',
      meta: {
        summary: 'Get a dynamic schedule',
        tags: ['Schedulers'],
        params: idParam,
        response: dynamicScheduleInfoSchema,
      },
      handler: async ({ params }) => {
        const schedules = core.options.queue?.schedules;
        if (!schedules) return storageError;
        try {
          return {
            status: 200,
            body: dynamicScheduleInfo(await schedules.retrieve(params.id!)),
          };
        } catch (err) {
          return { status: 404, body: { error: errorMessage(err) } };
        }
      },
    },

    {
      method: 'post',
      path: '/schedules/:id/run',
      meta: {
        summary: 'Run a dynamic schedule now',
        tags: ['Schedulers'],
        params: idParam,
        response: idResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const schedules = core.options.queue?.schedules;
        if (!schedules) return storageError;
        try {
          const result = await schedules.runNow(params.id!);
          return { status: 200, body: { id: result.runId } };
        } catch (err) {
          return { status: 404, body: { error: errorMessage(err) } };
        }
      },
    },

    {
      method: 'post',
      path: '/schedules/:id/activate',
      meta: {
        summary: 'Activate a dynamic schedule',
        tags: ['Schedulers'],
        params: idParam,
        response: dynamicScheduleInfoSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const schedules = core.options.queue?.schedules;
        if (!schedules) return storageError;
        try {
          return {
            status: 200,
            body: dynamicScheduleInfo(await schedules.activate(params.id!)),
          };
        } catch (err) {
          return { status: 404, body: { error: errorMessage(err) } };
        }
      },
    },

    {
      method: 'post',
      path: '/schedules/:id/deactivate',
      meta: {
        summary: 'Deactivate a dynamic schedule',
        tags: ['Schedulers'],
        params: idParam,
        response: dynamicScheduleInfoSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const schedules = core.options.queue?.schedules;
        if (!schedules) return storageError;
        try {
          return {
            status: 200,
            body: dynamicScheduleInfo(await schedules.deactivate(params.id!)),
          };
        } catch (err) {
          return { status: 404, body: { error: errorMessage(err) } };
        }
      },
    },

    {
      method: 'delete',
      path: '/schedules/:id',
      meta: {
        summary: 'Delete a dynamic schedule',
        tags: ['Schedulers'],
        params: idParam,
        response: successResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        const schedules = core.options.queue?.schedules;
        if (!schedules) return storageError;
        const ok = await schedules.delete(params.id!);
        if (!ok) return { status: 404, body: { error: 'Schedule not found' } };
        return { status: 200, body: { success: true } };
      },
    },

    {
      method: 'get',
      path: '/search',
      meta: {
        summary: 'Search jobs by id, name, data, or tag filters',
        tags: ['Search'],
        query: searchQuerySchema,
        response: searchResponseSchema,
      },
      handler: async ({ query }) => {
        const q = query.q || '';
        const limit = Number(query.limit) || 20;
        if (!q) return { status: 200, body: { results: [] } };
        const results = await qm.search(q, limit);
        return { status: 200, body: { results } };
      },
    },

    {
      method: 'get',
      path: '/tags/:field/values',
      meta: {
        summary: 'List distinct values for a tag field',
        tags: ['Search'],
        params: tagFieldParam,
        query: limitQuerySchema,
        response: tagValuesResponseSchema,
      },
      handler: async ({ params, query }) => {
        const field = params.field!;
        const limit = Number(query.limit) || 50;

        const tagFields = qm.getTagFields();
        if (tagFields.length > 0 && !tagFields.includes(field)) {
          return {
            status: 400,
            body: {
              error: `Field "${field}" is not a configured tag field`,
            },
          };
        }

        const values = await qm.getTagValues(field, limit);
        return { status: 200, body: { field, values } };
      },
    },

    {
      method: 'post',
      path: '/queues/:name/clean',
      meta: {
        summary: 'Clean completed or failed jobs from a queue',
        tags: ['Queues'],
        params: queueNameParam,
        body: cleanJobsSchema,
        response: cleanResultSchema,
      },
      handler: async ({ params, body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, cleanJobsSchema);
        if (!parsed.ok) return parsed.response;
        const req = parsed.data;
        const count = await qm.cleanJobs(
          params.name!,
          req.status,
          req.grace || 0,
        );
        return { status: 200, body: { removed: count } };
      },
    },

    {
      method: 'post',
      path: '/bulk/retry',
      meta: {
        summary: 'Retry multiple jobs across queues',
        tags: ['Jobs'],
        body: bulkJobsSchema,
      },
      handler: async ({ body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, bulkJobsSchema);
        if (!parsed.ok) return parsed.response;
        return { status: 200, body: await qm.bulkRetry(parsed.data.jobs) };
      },
    },

    {
      method: 'post',
      path: '/bulk/delete',
      meta: {
        summary: 'Delete multiple jobs across queues',
        tags: ['Jobs'],
        body: bulkJobsSchema,
      },
      handler: async ({ body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, bulkJobsSchema);
        if (!parsed.ok) return parsed.response;
        return { status: 200, body: await qm.bulkDelete(parsed.data.jobs) };
      },
    },

    {
      method: 'post',
      path: '/bulk/promote',
      meta: {
        summary: 'Promote multiple delayed jobs across queues',
        tags: ['Jobs'],
        body: bulkJobsSchema,
      },
      handler: async ({ body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, bulkJobsSchema);
        if (!parsed.ok) return parsed.response;
        return { status: 200, body: await qm.bulkPromote(parsed.data.jobs) };
      },
    },

    {
      method: 'post',
      path: '/queues/:name/pause',
      meta: {
        summary: 'Pause a queue',
        tags: ['Queues'],
        params: queueNameParam,
        response: queuePausedResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        try {
          await qm.pauseQueue(params.name!);
          return { status: 200, body: { success: true, paused: true } };
        } catch (error) {
          return {
            status: 404,
            body: {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to pause queue',
            },
          };
        }
      },
    },

    {
      method: 'post',
      path: '/queues/:name/resume',
      meta: {
        summary: 'Resume a queue',
        tags: ['Queues'],
        params: queueNameParam,
        response: queuePausedResponseSchema,
      },
      handler: async ({ params }) => {
        if (isReadonly()) return readonlyError;
        try {
          await qm.resumeQueue(params.name!);
          return { status: 200, body: { success: true, paused: false } };
        } catch (error) {
          return {
            status: 404,
            body: {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to resume queue',
            },
          };
        }
      },
    },

    {
      method: 'get',
      path: '/flows',
      meta: {
        summary: 'List job flows',
        tags: ['Flows'],
        query: limitQuerySchema,
        response: flowsListResponseSchema,
      },
      handler: async ({ query }) => {
        const limit = Number(query.limit) || 50;
        const flows = await qm.getFlows(limit);
        return { status: 200, body: { flows } };
      },
    },

    {
      method: 'get',
      path: '/flows/:queueName/:jobId',
      meta: {
        summary: 'Get a flow tree',
        tags: ['Flows'],
        params: flowParam,
        response: flowNodeSchema,
      },
      handler: async ({ params }) => {
        const flow = await qm.getFlow(params.queueName!, params.jobId!);
        if (!flow) {
          return { status: 404, body: { error: 'Flow not found' } };
        }
        return { status: 200, body: flow };
      },
    },

    {
      method: 'post',
      path: '/flows',
      meta: {
        summary: 'Create a job flow',
        tags: ['Flows'],
        body: createFlowRequestSchema,
        response: createFlowResponseSchema,
      },
      handler: async ({ body }) => {
        if (isReadonly()) return readonlyError;
        const parsed = parseBody(body, createFlowRequestSchema);
        if (!parsed.ok) return parsed.response;
        const req = parsed.data;

        try {
          const result = await qm.createFlow(req);
          return { status: 200, body: result };
        } catch (e) {
          return { status: 400, body: { error: errorMessage(e) } };
        }
      },
    },

    ...alertsRoutes(core),
  ];
}
