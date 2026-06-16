/**
 * Zod schemas for the Workbench HTTP API — the single source of truth for both
 * runtime request validation (see {@link parseBody} in `./handlers`) and the
 * generated OpenAPI document (see `./openapi`).
 *
 * Request schemas are authoritative: handlers derive their typed input from
 * `z.infer`. Response/entity schemas mirror the types in `../core/types` for
 * documentation.
 */
import { z } from 'zod';

// ── Shared ───────────────────────────────────────────────────────────────────

export const errorResponseSchema = z
  .object({
    error: z.string(),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  })
  .meta({ id: 'Error' });

export const successResponseSchema = z
  .object({ success: z.boolean() })
  .meta({ id: 'Success' });

export const idParam = z.object({ id: z.string() });

// ── Alerts ───────────────────────────────────────────────────────────────────

export const alertTriggerSchema = z
  .enum([
    'job_failed',
    'job_stalled',
    'retries_exhausted',
    'failed_backlog',
    'no_workers_with_backlog',
  ])
  .meta({ id: 'AlertTrigger' });

export const alertSeveritySchema = z
  .enum(['critical', 'warning', 'info'])
  .meta({ id: 'AlertSeverity' });

export const alertContactPointPresetSchema = z
  .enum(['slack', 'webhook', 'discord'])
  .meta({ id: 'AlertContactPointPreset' });

export const alertContactPointPublicSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    preset: alertContactPointPresetSchema,
    urlMasked: z.string(),
    enabled: z.boolean(),
    displayName: z.string().optional(),
    iconUrl: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: 'AlertContactPoint' });

export const alertRuleSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    enabled: z.boolean(),
    trigger: alertTriggerSchema,
    severity: alertSeveritySchema,
    queues: z.array(z.string()).optional(),
    jobNames: z.array(z.string()).optional(),
    threshold: z.number().optional(),
    contactPointIds: z.array(z.string()),
    cooldownMs: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: 'AlertRule' });

export const alertDeliveryRecordSchema = z
  .object({
    contactPointId: z.string(),
    contactPointName: z.string(),
    success: z.boolean(),
    error: z.string().optional(),
    at: z.number(),
  })
  .meta({ id: 'AlertDeliveryRecord' });

export const alertEventSchema = z
  .object({
    id: z.string(),
    ruleId: z.string(),
    ruleName: z.string(),
    trigger: alertTriggerSchema,
    severity: alertSeveritySchema,
    status: z.enum(['firing', 'resolved']),
    fingerprint: z.string(),
    queue: z.string().optional(),
    jobId: z.string().optional(),
    jobName: z.string().optional(),
    message: z.string(),
    failedReason: z.string().optional(),
    attemptsMade: z.number().optional(),
    counts: z
      .object({
        failed: z.number().optional(),
        backlog: z.number().optional(),
        workers: z.number().nullable().optional(),
      })
      .optional(),
    firedAt: z.number(),
    resolvedAt: z.number().optional(),
  })
  .meta({ id: 'AlertEvent' });

export const alertRuntimeStatusSchema = z
  .object({
    enabled: z.boolean(),
    persistence: z.enum(['redis', 'memory', 'custom', 'postgres']),
    listenerCount: z.number(),
    listeners: z.array(z.object({ queue: z.string(), connected: z.boolean() })),
    healthCheckIntervalMs: z.number(),
    lastHealthCheckAt: z.number().optional(),
    recentEvents: z.array(alertEventSchema),
    lastDeliveries: z.array(alertDeliveryRecordSchema),
    defaults: z.object({
      cooldownMs: z.number(),
      sendResolved: z.boolean(),
    }),
  })
  .meta({ id: 'AlertRuntimeStatus' });

// Request bodies (authoritative).

export const contactPointCreateSchema = z
  .object({
    name: z.string().min(1),
    preset: alertContactPointPresetSchema,
    url: z.string().min(1),
    enabled: z.boolean().optional(),
    displayName: z.string().optional(),
    iconUrl: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .meta({ id: 'ContactPointCreate' });

export const contactPointUpdateSchema = z
  .object({
    name: z.string().optional(),
    preset: alertContactPointPresetSchema.optional(),
    url: z.string().optional(),
    enabled: z.boolean().optional(),
    displayName: z.string().optional(),
    iconUrl: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
  })
  .meta({ id: 'ContactPointUpdate' });

export const ruleCreateSchema = z
  .object({
    name: z.string().min(1),
    trigger: alertTriggerSchema,
    contactPointIds: z.array(z.string()).min(1),
    enabled: z.boolean().optional(),
    severity: alertSeveritySchema.optional(),
    queues: z.array(z.string()).optional(),
    jobNames: z.array(z.string()).optional(),
    threshold: z.number().optional(),
    cooldownMs: z.number().optional(),
  })
  .meta({ id: 'RuleCreate' });

export const ruleUpdateSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    trigger: alertTriggerSchema.optional(),
    severity: alertSeveritySchema.optional(),
    queues: z.array(z.string()).optional(),
    jobNames: z.array(z.string()).optional(),
    threshold: z.number().optional(),
    contactPointIds: z.array(z.string()).optional(),
    cooldownMs: z.number().optional(),
  })
  .meta({ id: 'RuleUpdate' });

// ── Test & flows ─────────────────────────────────────────────────────────────

export const testEnqueueOptionsSchema = z
  .object({
    delay: z.number().optional(),
    priority: z.number().optional(),
    attempts: z.number().optional(),
  })
  .meta({ id: 'TestEnqueueOptions' });

export const testJobRequestSchema = z
  .object({
    type: z.enum(['job', 'flow']),
    id: z.string(),
    data: z.unknown(),
    opts: testEnqueueOptionsSchema.optional(),
  })
  .meta({ id: 'TestJobRequest' });

export const testJobResponseSchema = z
  .object({
    id: z.string(),
    type: z.enum(['job', 'flow']),
    name: z.string(),
    queueName: z.string(),
  })
  .meta({ id: 'TestJobResponse' });

export const createFlowChildSchema = z
  .object({
    name: z.string(),
    queueName: z.string(),
    data: z.unknown().optional(),
    get children() {
      return z.array(createFlowChildSchema).optional();
    },
  })
  .meta({ id: 'CreateFlowChild' });

export const createFlowRequestSchema = z
  .object({
    name: z.string(),
    queueName: z.string(),
    data: z.unknown().optional(),
    children: z.array(createFlowChildSchema),
  })
  .meta({ id: 'CreateFlowRequest' });

export const createFlowResponseSchema = z
  .object({ id: z.string() })
  .meta({ id: 'CreateFlowResponse' });

// ── Jobs, runs & queues ──────────────────────────────────────────────────────

export const jobStatusSchema = z
  .enum([
    'active',
    'waiting',
    'waiting-children',
    'prioritized',
    'completed',
    'failed',
    'delayed',
    'paused',
    'unknown',
  ])
  .meta({ id: 'JobStatus' });

export const jobTagsSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export const jobInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    data: z.unknown(),
    opts: z.object({
      attempts: z.number().optional(),
      delay: z.number().optional(),
      priority: z.number().optional(),
    }),
    progress: z.union([z.number(), z.object({})]),
    attemptsMade: z.number(),
    processedOn: z.number().optional(),
    finishedOn: z.number().optional(),
    timestamp: z.number(),
    failedReason: z.string().optional(),
    stacktrace: z.array(z.string()).optional(),
    returnvalue: z.unknown().optional(),
    status: jobStatusSchema,
    duration: z.number().optional(),
    tags: jobTagsSchema.optional(),
    parent: z.object({ id: z.string(), queueName: z.string() }).optional(),
  })
  .meta({ id: 'JobInfo' });

export const runInfoListSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    status: jobStatusSchema,
    queueName: z.string(),
    tags: jobTagsSchema.optional(),
    processedOn: z.number().optional(),
    timestamp: z.number(),
    duration: z.number().optional(),
    failedReason: z.string().optional(),
  })
  .meta({ id: 'RunInfoList' });

export const queueInfoSchema = z
  .object({
    name: z.string(),
    counts: z.object({
      waiting: z.number(),
      active: z.number(),
      completed: z.number(),
      failed: z.number(),
      delayed: z.number(),
      prioritized: z.number(),
      'waiting-children': z.number(),
      paused: z.number(),
    }),
    isPaused: z.boolean(),
    workerCount: z.number().nullable().optional(),
  })
  .meta({ id: 'QueueInfo' });

export const overviewStatsSchema = z
  .object({
    totalJobs: z.number(),
    activeJobs: z.number(),
    failedJobs: z.number(),
    completedToday: z.number(),
    avgDuration: z.number(),
    queues: z.array(queueInfoSchema),
  })
  .meta({ id: 'OverviewStats' });

export const searchResultSchema = z
  .object({ queue: z.string(), job: jobInfoSchema })
  .meta({ id: 'SearchResult' });

/** Wrap an item schema in the paginated response envelope. */
export function paginated<T extends z.ZodType>(item: T) {
  return z.object({
    data: z.array(item),
    total: z.number(),
    cursor: z.string().optional(),
    hasMore: z.boolean(),
  });
}

export const delayedJobInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    queueName: z.string(),
    delay: z.number(),
    processAt: z.number(),
    data: z.unknown(),
  })
  .meta({ id: 'DelayedJobInfo' });

// ── Schedulers ───────────────────────────────────────────────────────────────

export const schedulerInfoSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    queueName: z.string(),
    pattern: z.string().optional(),
    every: z.number().optional(),
    next: z.number().optional(),
    endDate: z.number().optional(),
    tz: z.string().optional(),
  })
  .meta({ id: 'SchedulerInfo' });

export const dynamicScheduleInfoSchema = z
  .object({
    id: z.string(),
    type: z.enum(['DECLARATIVE', 'IMPERATIVE']),
    task: z.string(),
    active: z.boolean(),
    cron: z.string(),
    timezone: z.string(),
    externalId: z.string().optional(),
    deduplicationKey: z.string().optional(),
    meta: z.record(z.string(), z.unknown()),
    nextRun: z.number().optional(),
    lastRun: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: 'DynamicScheduleInfo' });

export const schedulerDetailSchema = z
  .object({
    ...schedulerInfoSchema.shape,
    type: z.enum(['cron', 'interval']),
    upcoming: z.array(z.number()),
    recent: z.array(runInfoListSchema),
  })
  .meta({ id: 'SchedulerDetail' });

// ── Spans & logs ─────────────────────────────────────────────────────────────

export const runSpanInfoSchema = z
  .object({
    id: z.string(),
    attempt: z.number(),
    traceId: z.string(),
    spanId: z.string(),
    parentSpanId: z.string().optional(),
    kind: z.enum(['span', 'log']),
    name: z.string(),
    level: z.string().optional(),
    status: z.enum(['ok', 'error']).optional(),
    error: z
      .object({
        message: z.string(),
        name: z.string().optional(),
        stack: z.string().optional(),
      })
      .optional(),
    startedAt: z.number(),
    durationMs: z.number().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'RunSpanInfo' });

export const jobLogsResponseSchema = z
  .object({ logs: z.array(z.string()), count: z.number() })
  .meta({ id: 'JobLogsResponse' });

export const jobSpansResponseSchema = z
  .object({ spans: z.array(runSpanInfoSchema) })
  .meta({ id: 'JobSpansResponse' });

// ── Metrics & errors ─────────────────────────────────────────────────────────

export const hourlyBucketSchema = z
  .object({
    hour: z.number(),
    completed: z.number(),
    failed: z.number(),
    avgDuration: z.number(),
    avgWaitTime: z.number(),
  })
  .meta({ id: 'HourlyBucket' });

const queueMetricsSummarySchema = z.object({
  totalCompleted: z.number(),
  totalFailed: z.number(),
  errorRate: z.number(),
  avgDuration: z.number(),
  avgWaitTime: z.number(),
  throughputPerHour: z.number(),
});

export const queueMetricsSchema = z
  .object({
    queueName: z.string(),
    buckets: z.array(hourlyBucketSchema),
    summary: queueMetricsSummarySchema,
  })
  .meta({ id: 'QueueMetrics' });

export const slowestJobSchema = z
  .object({
    name: z.string(),
    queueName: z.string(),
    duration: z.number(),
    jobId: z.string(),
  })
  .meta({ id: 'SlowestJob' });

export const failingJobTypeSchema = z
  .object({
    name: z.string(),
    queueName: z.string(),
    jobId: z.string(),
    failCount: z.number(),
    totalCount: z.number(),
    errorRate: z.number(),
    errorClass: z.string().optional(),
    latestFailedReason: z.string().optional(),
    latestFailedAt: z.number().optional(),
    trend: z.array(z.number()).optional(),
  })
  .meta({ id: 'FailingJobType' });

export const metricsResponseSchema = z
  .object({
    queues: z.array(queueMetricsSchema),
    aggregate: z.object({
      queueName: z.literal('all'),
      buckets: z.array(hourlyBucketSchema),
      summary: queueMetricsSummarySchema,
    }),
    slowestJobs: z.array(slowestJobSchema),
    mostFailingTypes: z.array(failingJobTypeSchema),
    computedAt: z.number(),
  })
  .meta({ id: 'MetricsResponse' });

export const errorsResponseSchema = z
  .object({
    groups: z.array(failingJobTypeSchema),
    buckets: z.array(hourlyBucketSchema),
    summary: queueMetricsSummarySchema,
    computedAt: z.number(),
  })
  .meta({ id: 'ErrorsResponse' });

// ── Flows & activity ─────────────────────────────────────────────────────────

export const flowNodeSchema = z
  .object({
    job: jobInfoSchema,
    queueName: z.string(),
    get children() {
      return z.array(flowNodeSchema).optional();
    },
  })
  .meta({ id: 'FlowNode' });

export const flowSummarySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    queueName: z.string(),
    status: jobStatusSchema,
    totalJobs: z.number(),
    completedJobs: z.number(),
    failedJobs: z.number(),
    timestamp: z.number(),
    duration: z.number().optional(),
  })
  .meta({ id: 'FlowSummary' });

export const activityStatsResponseSchema = z
  .object({
    buckets: z.array(
      z.object({
        time: z.number(),
        completed: z.number(),
        failed: z.number(),
      }),
    ),
    startTime: z.number(),
    endTime: z.number(),
    bucketSize: z.number(),
    totalCompleted: z.number(),
    totalFailed: z.number(),
    computedAt: z.number(),
  })
  .meta({ id: 'ActivityStatsResponse' });

// ── Path params ──────────────────────────────────────────────────────────────

export const queueNameParam = z.object({ name: z.string() });
export const jobParam = z.object({ queue: z.string(), id: z.string() });
export const schedulerParam = z.object({ queue: z.string(), key: z.string() });
export const tagFieldParam = z.object({ field: z.string() });
export const flowParam = z.object({ queueName: z.string(), jobId: z.string() });

// ── Query params (all values arrive as strings) ──────────────────────────────

const q = z.string().optional();

export const runsQuerySchema = z.object({
  limit: q,
  cursor: q,
  sort: q,
  status: q,
  q,
  from: q,
  to: q,
  tags: q,
});
export const queueJobsQuerySchema = z.object({
  status: q,
  limit: q,
  cursor: q,
  sort: q,
});
export const jobLogsQuerySchema = z.object({ start: q, end: q, asc: q });
export const schedulersQuerySchema = z.object({
  repeatableSort: q,
  delayedSort: q,
  dynamicSort: q,
  task: q,
  externalId: q,
  active: q,
  meta: q,
  limit: q,
  cursor: q,
});
export const searchQuerySchema = z.object({ q, limit: q });
export const limitQuerySchema = z.object({ limit: q });

// ── Request bodies for queue/bulk operations ─────────────────────────────────

export const cleanJobsSchema = z
  .object({
    status: z.enum(['completed', 'failed']),
    grace: z.number().optional(),
  })
  .meta({ id: 'CleanJobs' });

export const bulkJobsSchema = z
  .object({
    jobs: z.array(z.object({ queueName: z.string(), jobId: z.string() })),
  })
  .meta({ id: 'BulkJobs' });

// ── Misc response envelopes ──────────────────────────────────────────────────

export const searchResponseSchema = z
  .object({ results: z.array(searchResultSchema) })
  .meta({ id: 'SearchResponse' });

export const tagValuesResponseSchema = z
  .object({
    field: z.string(),
    values: z.array(z.object({ value: z.string(), count: z.number() })),
  })
  .meta({ id: 'TagValuesResponse' });

export const flowsListResponseSchema = z
  .object({ flows: z.array(flowSummarySchema) })
  .meta({ id: 'FlowsListResponse' });

export const cleanResultSchema = z
  .object({ removed: z.number() })
  .meta({ id: 'CleanResult' });

export const queuePausedResponseSchema = z
  .object({ success: z.boolean(), paused: z.boolean() })
  .meta({ id: 'QueuePausedResponse' });

export const idResponseSchema = z
  .object({ id: z.string() })
  .meta({ id: 'IdResponse' });

export type ContactPointCreate = z.infer<typeof contactPointCreateSchema>;
export type ContactPointUpdate = z.infer<typeof contactPointUpdateSchema>;
export type RuleCreate = z.infer<typeof ruleCreateSchema>;
export type RuleUpdate = z.infer<typeof ruleUpdateSchema>;
