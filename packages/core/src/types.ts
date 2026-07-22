import type { z } from 'zod';

export type RunStatus =
  | 'queued'
  | 'delayed'
  | 'executing'
  | 'reattempting'
  | 'waiting_children'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'timed_out'
  | 'expired';

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  retryable?: boolean;
  cause?: SerializedError;
}

export interface QueueRunSnapshot {
  id: string;
  transportJobId?: string;
  name: string;
  queue: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: SerializedError;
  meta: EnqueueMeta;
  metadata: Record<string, unknown>;
  tags: string[];
  scheduleId?: string;
  scheduleExternalId?: string;
  attempt: number;
  maxAttempts: number;
  willRetry: boolean;
  parentRunId?: string;
  createdAt: Date;
  queuedAt?: Date;
  startedAt?: Date;
  finishedAt?: Date;
  delayedUntil?: Date;
  durationMs?: number;
  traceCarrier?: Record<string, string>;
}

export interface TaskLogger {
  info: (message: string, attrs?: Record<string, unknown>) => void;
  warn: (message: string, attrs?: Record<string, unknown>) => void;
  error: (message: string, attrs?: Record<string, unknown>) => void;
  debug: (message: string, attrs?: Record<string, unknown>) => void;
}

export interface TaskContext<I = unknown> {
  id: string;
  transportJobId?: string;
  name: string;
  input: I;
  tags: string[];
  attempt: { number: number; max: number };
  signal: AbortSignal;
  logger: TaskLogger;
  trigger: <T>(
    target: string | TaskDefinition<T, unknown>,
    input: T,
    opts?: EnqueueOptions,
  ) => Promise<EnqueueResult>;
  progress: (patch: Record<string, unknown>) => Promise<void>;
  /**
   * Run `fn` inside a child OpenTelemetry span of the current attempt. Any
   * spans / log events produced inside nest under this one, letting handlers
   * carve the attempt into semantically-meaningful units (e.g. `db.query`,
   * `s3.upload`). No-op when OTel isn't configured.
   */
  withSpan: <T>(
    name: string,
    fn: () => Promise<T>,
    attributes?: Record<string, string | number | boolean>,
  ) => Promise<T>;
}

export type TaskHandler<I, O> = (ctx: TaskContext<I>) => Promise<O>;

export interface BackoffOptions {
  type: 'exponential' | 'fixed';
  delay: number;
}

export interface TaskDefinitionInput<I = unknown, O = unknown> {
  id: string;
  name?: string;
  queue?: string | QueueDefinition;
  schema?: z.ZodType<I>;
  description?: string;
  run?: (payload: I, ctx: TaskContext<I>) => Promise<O>;
  concurrency?: number;
  attempts?: number;
  backoff?: BackoffOptions | number;
  cron?: string;
  maxStalledCount?: number;
  tags?: string[];
}

export interface TaskDefinition<I = unknown, O = unknown> {
  id: string;
  name: string;
  queue: string;
  schema?: z.ZodType<I>;
  description?: string;
  handler: TaskHandler<I, O>;
  concurrency: number;
  attempts: number;
  backoff: BackoffOptions;
  cron?: string;
  maxStalledCount?: number;
  tags: string[];
  __input?: I;
  __output?: O;
}

export interface QueueDefinition {
  name: string;
  concurrency?: number;
}

/**
 * Identity slice stamped onto runs and schedules created through the control
 * API (`meta.enqueuedBy`). It is a reserved meta key — the control API strips
 * any inbound value and re-stamps the verified caller.
 */
export interface RunPrincipal {
  /** e.g. 'api-key' | 'http-basic' | 'jwt-hmac' | 'oidc' | 'local-dev' | 'none' | custom. */
  authenticator: string;
  principalId: string;
  /** Well-known: 'service' | 'user' | 'local-dev' | 'anonymous'. Plain string for forward compat. */
  principalType: string;
  tenantId?: string;
}

export interface EnqueueMeta {
  tags?: string[];
  parentRunId?: string;
  scheduleId?: string;
  scheduleExternalId?: string;
  enqueuedBy?: RunPrincipal;
  [key: string]: unknown;
}

export interface EnqueueOptions {
  runId?: string;
  jobId?: string;
  delay?: number;
  priority?: number;
  attempts?: number;
  backoff?: BackoffOptions | number;
  failParentOnFailure?: boolean;
  continueParentOnFailure?: boolean;
  ignoreDependencyOnFailure?: boolean;
  meta?: EnqueueMeta;
}

export interface EnqueueResult {
  runId: string;
  jobId: string;
}

export interface ScheduledTaskPayload {
  scheduleId: string;
  type: 'DECLARATIVE' | 'IMPERATIVE';
  timestamp: Date;
  lastTimestamp?: Date;
  externalId?: string;
  timezone: string;
  upcoming: Date[];
}

export interface QueueSchedule {
  id: string;
  type: 'DECLARATIVE' | 'IMPERATIVE';
  task: string;
  input?: unknown;
  active: boolean;
  cron: string;
  timezone: string;
  externalId?: string;
  deduplicationKey?: string;
  meta: EnqueueMeta;
  nextRun?: Date;
  lastRun?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateQueueScheduleOptions {
  task: string | TaskDefinition;
  input?: unknown;
  cron: string;
  timezone?: string;
  externalId?: string;
  deduplicationKey: string;
  meta?: EnqueueMeta;
}

export interface UpdateQueueScheduleOptions {
  task?: string | TaskDefinition;
  input?: unknown;
  cron?: string;
  timezone?: string;
  externalId?: string | null;
  deduplicationKey?: string;
  meta?: EnqueueMeta;
}

export interface QueueScheduleListOptions {
  task?: string;
  externalId?: string;
  active?: boolean;
  /** Deep-containment filter over `meta` (Postgres `@>` semantics on both stores). */
  meta?: Record<string, unknown>;
  sort?: {
    field: 'nextRun' | 'lastRun' | 'createdAt' | 'updatedAt';
    direction: 'asc' | 'desc';
  };
  limit?: number;
  cursor?: string;
}

export interface QueueScheduleCreateInput
  extends Omit<CreateQueueScheduleOptions, 'task' | 'timezone'> {
  id: string;
  task: string;
  type?: 'DECLARATIVE' | 'IMPERATIVE';
  input?: unknown;
  timezone: string;
  nextRunAt: Date;
}

export interface QueueScheduleUpdateInput
  extends Omit<UpdateQueueScheduleOptions, 'task'> {
  task?: string;
  type?: 'DECLARATIVE' | 'IMPERATIVE';
  input?: unknown;
  nextRunAt?: Date;
}

export interface QueueScheduleStore {
  create(input: QueueScheduleCreateInput): Promise<QueueSchedule>;
  retrieve(id: string): Promise<QueueSchedule | undefined>;
  list(options?: QueueScheduleListOptions): Promise<QueueSchedule[]>;
  update(
    id: string,
    input: QueueScheduleUpdateInput,
  ): Promise<QueueSchedule | undefined>;
  activate(id: string): Promise<QueueSchedule | undefined>;
  deactivate(id: string): Promise<QueueSchedule | undefined>;
  delete(id: string): Promise<boolean>;
  complete(
    id: string,
    lastRunAt: Date,
    nextRunAt: Date,
  ): Promise<QueueSchedule | undefined>;
}

export interface QueueSchedulesApi {
  create(options: CreateQueueScheduleOptions): Promise<QueueSchedule>;
  retrieve(id: string): Promise<QueueSchedule>;
  list(options?: QueueScheduleListOptions): Promise<QueueSchedule[]>;
  runNow(id: string): Promise<EnqueueResult>;
  update(
    id: string,
    options: UpdateQueueScheduleOptions,
  ): Promise<QueueSchedule>;
  activate(id: string): Promise<QueueSchedule>;
  deactivate(id: string): Promise<QueueSchedule>;
  delete(id: string): Promise<boolean>;
  timezones(): Promise<string[]>;
}

export interface TaskSchedulesApi {
  create(
    options: Omit<CreateQueueScheduleOptions, 'task'>,
  ): Promise<QueueSchedule>;
  list(
    options?: Omit<QueueScheduleListOptions, 'task'>,
  ): Promise<QueueSchedule[]>;
  delete(id: string): Promise<boolean>;
}

export interface FlowTaskDefinition {
  id?: string;
  name: string;
  queue: string;
  schema?: { parse(input: unknown): unknown };
  attempts: number;
  backoff: BackoffOptions;
  maxStalledCount?: number;
  tags: string[];
}

export interface FlowChildSpec<I = unknown> {
  def: FlowTaskDefinition;
  input: I;
  opts?: EnqueueOptions;
  children?: FlowChildSpec[];
}

export interface FlowParentSpec<I = unknown> extends FlowChildSpec<I> {
  children: FlowChildSpec[];
}

export interface Task<I = unknown, O = unknown> extends TaskDefinition<I, O> {
  trigger: (input: I, opts?: EnqueueOptions) => Promise<EnqueueResult>;
  schedules: TaskSchedulesApi;
  child: (
    input: I,
    opts?: EnqueueOptions,
    children?: FlowChildSpec[],
  ) => FlowChildSpec<I>;
}

export interface QueueCatalogEntry {
  id: string;
  name: string;
  queue: string;
  attempts: number;
  backoff: BackoffOptions;
  concurrency: number;
  maxStalledCount?: number;
  cron?: string;
  tags: string[];
  description?: string;
  schema?: {
    type: string;
  };
  updatedAt: string;
  version: string;
}

export interface QueueCatalogStore {
  publish(entries: QueueCatalogEntry[]): Promise<void>;
  resolve(id: string): Promise<QueueCatalogEntry | undefined>;
  read(): Promise<QueueCatalogEntry[]>;
}

export interface QueueRun {
  id: string;
  transportJobId?: string;
  task: string;
  queue: string;
  status: RunStatus;
  input: unknown;
  output?: unknown;
  error?: SerializedError;
  meta: EnqueueMeta;
  metadata: Record<string, unknown>;
  tags: string[];
  scheduleId?: string;
  scheduleExternalId?: string;
  createdAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
  updatedAt: Date;
}

export interface QueueRunListOptions {
  id?: string;
  /** Deep-containment filter over `meta` (Postgres `@>` semantics on both stores). */
  meta?: Record<string, unknown>;
  scheduleId?: string;
  scheduleExternalId?: string;
  task?: string;
  status?: RunStatus;
  timeRange?: {
    start: Date;
    end: Date;
  };
  sort?: {
    field: 'createdAt' | 'startedAt' | 'finishedAt' | 'updatedAt';
    direction: 'asc' | 'desc';
  };
  limit?: number;
  cursor?: string;
}

export interface QueueRunListResult {
  data: QueueRun[];
  cursor?: string;
  hasMore: boolean;
}

/** Absolute deletion cutoffs per retention category; an unset field skips it. */
export interface RetentionCutoffs {
  /** Delete completed/canceled runs that finished before this. */
  completedBefore?: Date;
  /** Delete failed (failed/timed_out/expired) runs that finished before this. */
  failedBefore?: Date;
  /** Delete run events and spans recorded before this. */
  logsBefore?: Date;
}

/**
 * Outcome of a store prune: the deletion counts, or `skipped: true` when
 * another replica held the store's prune coordination lock and this call did
 * nothing. Stores without cross-replica coordination always return counts.
 */
export type PruneResult =
  | { skipped?: false; runs: number; events: number; spans: number }
  | { skipped: true };

export interface QueueRunStore {
  list(options?: QueueRunListOptions): Promise<QueueRunListResult>;
  /**
   * Delete run history past the given cutoffs: terminal runs by their finish
   * time, plus events/spans older than `logsBefore` or orphaned by run
   * deletion. Runs that never finished are never pruned. Optional — the
   * retention sweep skips stores without it.
   */
  prune?(cutoffs: RetentionCutoffs): Promise<PruneResult>;
}

export interface QueueRunPollOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export type CancelRunResult =
  | { outcome: 'canceled'; run: QueueRun }
  | { outcome: 'not_found' }
  | { outcome: 'already_finished'; run: QueueRun }
  | { outcome: 'not_cancelable'; run: QueueRun; reason: 'executing' };

export interface QueueRunsApi extends QueueRunStore {
  retrieve(id: string): Promise<QueueRun | undefined>;
  poll(id: string, options?: QueueRunPollOptions): Promise<QueueRun>;
  cancel(id: string): Promise<CancelRunResult>;
}

export type RunSpanKind = 'span' | 'log';

/**
 * One row of a run's execution timeline: either a span (a timed unit of work)
 * or a log line attached to the span that emitted it. The tree is rebuilt
 * from `parentSpanId`; ids are real OpenTelemetry trace/span ids so rows can
 * be cross-referenced with an external tracing backend.
 */
export interface QueueRunSpan {
  id: string;
  runId: string;
  attempt: number;
  traceId: string;
  /** For logs: the owning span's id. */
  spanId: string;
  /** Absent on per-attempt root spans whose parent lives outside the run. */
  parentSpanId?: string;
  kind: RunSpanKind;
  /** Span name, or the log message for kind 'log'. */
  name: string;
  level?: string;
  status?: 'ok' | 'error';
  /** Recorded exception for failed spans (folded from the OTEL exception event). */
  error?: { message: string; name?: string; stack?: string };
  startedAt: Date;
  durationMs?: number;
  attributes?: Record<string, unknown>;
}

export interface QueueSpanStore {
  insertMany(spans: QueueRunSpan[]): Promise<void>;
  listByRun(runId: string): Promise<QueueRunSpan[]>;
}

export type QueueDrainEvent =
  | { type: 'enqueue'; run: QueueRunSnapshot }
  | { type: 'start'; run: QueueRunSnapshot }
  | { type: 'progress'; run: QueueRunSnapshot; patch: Record<string, unknown> }
  | { type: 'complete'; run: QueueRunSnapshot }
  | { type: 'fail'; run: QueueRunSnapshot }
  | { type: 'cancel'; run: QueueRunSnapshot };

export interface QueueDrain {
  name?: string;
  handle(event: QueueDrainEvent): Promise<void> | void;
}

export type AlertTrigger =
  | 'job_failed'
  | 'job_stalled'
  | 'retries_exhausted'
  | 'failed_backlog'
  | 'no_workers_with_backlog';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertContactPointPreset = 'slack' | 'webhook' | 'discord';

export interface AlertContactPoint {
  id: string;
  name: string;
  preset: AlertContactPointPreset;
  url: string;
  enabled: boolean;
  displayName?: string;
  iconUrl?: string;
  headers?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AlertTrigger;
  severity: AlertSeverity;
  queues?: string[];
  jobNames?: string[];
  threshold?: number;
  contactPointIds: string[];
  cooldownMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AlertStore {
  getContactPoints(): Promise<AlertContactPoint[]>;
  getContactPoint(id: string): Promise<AlertContactPoint | undefined>;
  createContactPoint(
    input: Omit<AlertContactPoint, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<AlertContactPoint>;
  updateContactPoint(
    id: string,
    input: Partial<Omit<AlertContactPoint, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<AlertContactPoint | undefined>;
  deleteContactPoint(id: string): Promise<boolean>;
  getRules(): Promise<AlertRule[]>;
  getRule(id: string): Promise<AlertRule | undefined>;
  createRule(
    input: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<AlertRule>;
  updateRule(
    id: string,
    input: Partial<Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>>,
  ): Promise<AlertRule | undefined>;
  deleteRule(id: string): Promise<boolean>;
  close?(): Promise<void>;
}

export interface QueueState extends QueueDrain {
  schedules: QueueScheduleStore;
  runs: QueueRunStore;
  alerts: AlertStore;
}

export interface QueueStorage extends QueueCatalogStore, QueueState {
  spans?: QueueSpanStore;
}
