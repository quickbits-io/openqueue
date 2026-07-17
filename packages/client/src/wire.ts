import { z } from 'zod';

export const CONTROL_PREFIX = '/openqueue/v1';

export const runStatusSchema = z.enum([
  'queued',
  'delayed',
  'executing',
  'reattempting',
  'waiting_children',
  'completed',
  'failed',
  'canceled',
  'timed_out',
  'expired',
]);
export type WireRunStatus = z.infer<typeof runStatusSchema>;

export const backoffSchema = z.object({
  type: z.enum(['exponential', 'fixed']),
  delay: z.number(),
});
export type WireBackoff = z.infer<typeof backoffSchema>;

export interface WireSerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  retryable?: boolean;
  cause?: WireSerializedError;
}
export const serializedErrorSchema: z.ZodType<WireSerializedError> = z.lazy(
  () =>
    z.object({
      name: z.string(),
      message: z.string(),
      stack: z.string().optional(),
      code: z.string().optional(),
      retryable: z.boolean().optional(),
      cause: serializedErrorSchema.optional(),
    }),
);

export const runPrincipalSchema = z.object({
  authenticator: z.string(),
  principalId: z.string(),
  principalType: z.string(),
  tenantId: z.string().optional(),
});
export type WireRunPrincipal = z.infer<typeof runPrincipalSchema>;

export const enqueueMetaSchema = z.looseObject({
  tags: z.array(z.string()).optional(),
  parentRunId: z.string().optional(),
  scheduleId: z.string().optional(),
  scheduleExternalId: z.string().optional(),
  enqueuedBy: runPrincipalSchema.optional(),
});
export type WireEnqueueMeta = z.infer<typeof enqueueMetaSchema>;

export const wireRunSchema = z.object({
  id: z.string(),
  transportJobId: z.string().optional(),
  task: z.string(),
  queue: z.string(),
  status: runStatusSchema,
  input: z.unknown(),
  output: z.unknown().optional(),
  error: serializedErrorSchema.optional(),
  meta: enqueueMetaSchema,
  metadata: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  scheduleId: z.string().optional(),
  scheduleExternalId: z.string().optional(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
});
export type WireRun = z.infer<typeof wireRunSchema>;

export const wireRunListSchema = z.object({
  data: z.array(wireRunSchema),
  cursor: z.string().optional(),
  hasMore: z.boolean(),
});
export type WireRunList = z.infer<typeof wireRunListSchema>;

export const enqueueOptionsSchema = z.object({
  runId: z.string().optional(),
  jobId: z.string().optional(),
  delay: z.number().int().nonnegative().optional(),
  priority: z.number().int().optional(),
  attempts: z.number().int().positive().optional(),
  backoff: z.union([backoffSchema, z.number()]).optional(),
  ttl: z.number().int().positive().optional(),
  meta: enqueueMetaSchema.optional(),
});
export type WireEnqueueOptions = z.infer<typeof enqueueOptionsSchema>;

export const enqueueRequestSchema = z.object({
  task: z.string().min(1),
  input: z.unknown().optional(),
  options: enqueueOptionsSchema.optional(),
});
export type WireEnqueueRequest = z.infer<typeof enqueueRequestSchema>;

export const enqueueResultSchema = z.object({
  id: z.string(),
  runId: z.string(),
  jobId: z.string(),
  transportJobId: z.string(),
});
export type WireEnqueueResult = z.infer<typeof enqueueResultSchema>;

export const wireScheduleSchema = z.object({
  id: z.string(),
  type: z.enum(['DECLARATIVE', 'IMPERATIVE']),
  task: z.string(),
  input: z.unknown().optional(),
  active: z.boolean(),
  cron: z.string(),
  timezone: z.string(),
  externalId: z.string().optional(),
  deduplicationKey: z.string().optional(),
  meta: enqueueMetaSchema,
  nextRun: z.iso.datetime().optional(),
  lastRun: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type WireSchedule = z.infer<typeof wireScheduleSchema>;

export const wireScheduleListSchema = z.array(wireScheduleSchema);
export type WireScheduleList = z.infer<typeof wireScheduleListSchema>;

export const scheduleDeletedResponseSchema = z.object({ deleted: z.boolean() });
export type WireScheduleDeletedResponse = z.infer<
  typeof scheduleDeletedResponseSchema
>;

export const createScheduleRequestSchema = z.object({
  task: z.string().min(1),
  input: z.unknown().optional(),
  cron: z.string().min(1),
  timezone: z.string().optional(),
  externalId: z.string().optional(),
  deduplicationKey: z.string().min(1),
  meta: enqueueMetaSchema.optional(),
});
export type WireCreateScheduleRequest = z.infer<
  typeof createScheduleRequestSchema
>;

export const updateScheduleRequestSchema = z.object({
  task: z.string().optional(),
  input: z.unknown().optional(),
  cron: z.string().optional(),
  timezone: z.string().optional(),
  externalId: z.string().nullable().optional(),
  deduplicationKey: z.string().optional(),
  meta: enqueueMetaSchema.optional(),
});
export type WireUpdateScheduleRequest = z.infer<
  typeof updateScheduleRequestSchema
>;

export const wireCatalogEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  queue: z.string(),
  attempts: z.number(),
  backoff: backoffSchema,
  concurrency: z.number(),
  ttl: z.number().optional(),
  maxStalledCount: z.number().optional(),
  cron: z.string().optional(),
  tags: z.array(z.string()),
  description: z.string().optional(),
  schema: z.object({ type: z.string() }).optional(),
  updatedAt: z.string(),
  version: z.string(),
});
export type WireCatalogEntry = z.infer<typeof wireCatalogEntrySchema>;

export const catalogResponseSchema = z.object({
  tasks: z.array(wireCatalogEntrySchema),
});
export type WireCatalogResponse = z.infer<typeof catalogResponseSchema>;

export const cancelRunResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('canceled'), run: wireRunSchema }),
  z.object({ outcome: z.literal('already_finished'), run: wireRunSchema }),
  z.object({
    outcome: z.literal('not_cancelable'),
    run: wireRunSchema,
    reason: z.literal('executing'),
  }),
]);
export type WireCancelRunResponse = z.infer<typeof cancelRunResponseSchema>;

export const healthResponseSchema = z.object({ ok: z.boolean() });
export type WireHealthResponse = z.infer<typeof healthResponseSchema>;

export const infoResponseSchema = z.object({
  service: z.literal('openqueue'),
  apiVersion: z.literal(1),
  namespace: z.string(),
  tasks: z.number().int(),
  queues: z.array(z.string()),
});
export type WireInfoResponse = z.infer<typeof infoResponseSchema>;

/** Server-known codes; wire schema keeps `code` a plain string for forward compat. */
export type WireErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_request'
  | 'task_not_found'
  | 'run_not_found'
  | 'schedule_not_found'
  | 'internal';

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    issues: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional(),
  }),
});
export type WireErrorResponse = z.infer<typeof errorResponseSchema>;
export type WireErrorBody = WireErrorResponse['error'];
