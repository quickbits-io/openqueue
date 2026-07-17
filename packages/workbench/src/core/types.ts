import type {
  AuthStrategy,
  QueueRunSpan,
  QueueSchedule,
  QueueScheduleListOptions,
} from '@openqueue/core';
import type { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';

/**
 * Job status types matching BullMQ states
 */
export type JobStatus =
  | 'active'
  | 'waiting'
  | 'waiting-children'
  | 'prioritized'
  | 'completed'
  | 'failed'
  | 'delayed'
  | 'paused'
  | 'unknown';

export interface WorkbenchSchema<I = unknown> {
  parse(input: unknown): I;
}

export interface WorkbenchJobDefinition<I = unknown, O = unknown> {
  name: string;
  queue: string;
  schema?: WorkbenchSchema<I>;
  description?: string;
  handler: unknown;
  concurrency: number;
  attempts: number;
  backoff: unknown;
  cron?: string;
  maxStalledCount?: number;
  tags: string[];
  __input?: I;
  __output?: O;
}

export interface WorkbenchFlowTemplate<I = unknown> {
  id: string;
  name: string;
  queue: string;
  description: string;
  schema?: WorkbenchSchema<I>;
  build(input: I): unknown;
}

export type TestTargetType = 'job' | 'flow';

export interface TestEnqueueOptions {
  delay?: number;
  priority?: number;
  attempts?: number;
}

export interface WorkbenchEnqueueResult {
  runId: string;
  jobId: string;
}

export interface WorkbenchRegistry {
  jobs: WorkbenchJobDefinition[];
  flows?: WorkbenchFlowTemplate[];
  enqueueJob(
    job: WorkbenchJobDefinition,
    input: unknown,
    opts?: TestEnqueueOptions,
  ): Promise<WorkbenchEnqueueResult>;
  enqueueFlow(flow: unknown): Promise<WorkbenchEnqueueResult>;
}

export interface WorkbenchRegistryJob {
  type: 'job';
  id: string;
  name: string;
  queue: string;
  description?: string;
  attempts: number;
  cron?: string;
  tags: string[];
}

export interface WorkbenchRegistryFlow {
  type: 'flow';
  id: string;
  name: string;
  queue: string;
  description: string;
  tags: string[];
}

export interface WorkbenchRegistryConfig {
  jobs: WorkbenchRegistryJob[];
  flows: WorkbenchRegistryFlow[];
}

export type WorkbenchDynamicSchedule = QueueSchedule;

export type WorkbenchScheduleListOptions = QueueScheduleListOptions;

export interface WorkbenchSchedulesStorage {
  list(
    options?: WorkbenchScheduleListOptions,
  ): Promise<WorkbenchDynamicSchedule[]>;
  retrieve(id: string): Promise<WorkbenchDynamicSchedule>;
  runNow(id: string): Promise<WorkbenchEnqueueResult>;
  activate(id: string): Promise<WorkbenchDynamicSchedule>;
  deactivate(id: string): Promise<WorkbenchDynamicSchedule>;
  delete(id: string): Promise<boolean>;
}

export interface WorkbenchSpansStorage {
  listByRun(runId: string): Promise<QueueRunSpan[]>;
}

export interface WorkbenchQueueRuntime {
  schedules?: WorkbenchSchedulesStorage;
  spans?: WorkbenchSpansStorage;
}

export interface WorkbenchCapabilities {
  storage: boolean;
  dynamicSchedules: boolean;
  dynamicScheduleMutations: boolean;
  postgresAlerts: boolean;
  spans: boolean;
}

/**
 * Configuration options for Workbench
 */
export interface WorkbenchOptions {
  /** BullMQ Queue instances to display */
  queues?: Queue[];
  /** Redis connection for auto-discovery of queues */
  redis?: string | RedisOptions;
  /** Basic auth credentials (sugar for `[httpBasic(...)]`) or an ordered
   *  {@link AuthStrategy} walk. Unset = dashboard open (existing behavior). */
  auth?: { username: string; password: string } | AuthStrategy[];
  /** Dashboard title */
  title?: string;
  /** Logo URL */
  logo?: string;
  /** Override base path detection */
  basePath?: string;
  /** Disable actions (retry, remove, promote) */
  readonly?: boolean;
  /** Fields from job.data to extract as filterable tags */
  tagFields?: string[];
  /**
   * BullMQ key prefix used during queue auto-discovery from `redis`. Ignored
   * when `queues` is set explicitly. Defaults to `"bull"`.
   */
  prefix?: string;
  /**
   * Maximum number of queues to keep when auto-discovering from `redis`.
   * Prevents connection storms on very large Redis deployments. Defaults to
   * 100. Ignored when `queues` is set explicitly.
   */
  maxQueues?: number;
  /** Self-hosted alerting configuration */
  alerts?: AlertsOptions;
  /** Job and flow registry used by the Test page */
  registry?: WorkbenchRegistry;
  /** Queue runtime used for queue-owned dynamic state and light controls */
  queue?: WorkbenchQueueRuntime;
  /**
   * Source URL for the Scalar API-reference bundle served at `/api/reference`.
   * Defaults to Scalar's CDN. Set this to a self-hosted copy of
   * `@scalar/api-reference`'s browser bundle to serve the API docs fully offline.
   */
  scalarCdn?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert Types
// ─────────────────────────────────────────────────────────────────────────────

/** Supported alert trigger types */
export type AlertTrigger =
  | 'job_failed'
  | 'job_stalled'
  | 'retries_exhausted'
  | 'failed_backlog'
  | 'no_workers_with_backlog';

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertContactPointPreset = 'slack' | 'webhook' | 'discord';

/** Where notifications are sent (Slack/Discord incoming webhook or generic webhook) */
export interface AlertContactPoint {
  id: string;
  name: string;
  preset: AlertContactPointPreset;
  /** Webhook URL — stored server-side; API responses mask this value */
  url: string;
  enabled: boolean;
  displayName?: string;
  iconUrl?: string;
  /** Extra headers for generic webhook preset */
  headers?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

/** Rule that maps a trigger to one or more contact points */
export interface AlertRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AlertTrigger;
  severity: AlertSeverity;
  /** Empty or omitted = all queues */
  queues?: string[];
  /** Optional job name filter for event triggers */
  jobNames?: string[];
  /** Threshold for backlog-style triggers (failed count or waiting count) */
  threshold?: number;
  contactPointIds: string[];
  cooldownMs?: number;
  createdAt: number;
  updatedAt: number;
}

/** Pluggable persistence for alert contact points and rules */
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

export type AlertPersistence = 'redis' | 'memory' | 'custom' | 'postgres';

export interface AlertsOptions {
  /** Set to `false` to disable alerting entirely. Default: on. */
  enabled?: boolean;
  /** Set to `false` to keep alert config routes available without starting queue listeners. */
  delivery?: boolean;
  /** Seed data imported into Redis on first run when the store is empty */
  contactPoints?: AlertContactPoint[];
  /** Seed data imported into Redis on first run when the store is empty */
  rules?: AlertRule[];
  /** Override the config store entirely */
  store?: AlertStore;
  /** Where to persist dashboard-managed config. Default: `"redis"` when a connection exists */
  persistence?: AlertPersistence;
  /** Redis key prefix for stored config. Default: Workbench `prefix` or `"bull"` */
  storagePrefix?: string;
  defaults?: {
    cooldownMs?: number;
    sendResolved?: boolean;
  };
  /** Public dashboard URL included in notification links */
  dashboardUrl?: string;
}

/** Normalized alert event for delivery and activity log */
export interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  trigger: AlertTrigger;
  severity: AlertSeverity;
  status: 'firing' | 'resolved';
  fingerprint: string;
  queue?: string;
  jobId?: string;
  jobName?: string;
  message: string;
  failedReason?: string;
  attemptsMade?: number;
  counts?: {
    failed?: number;
    backlog?: number;
    workers?: number | null;
  };
  firedAt: number;
  resolvedAt?: number;
}

/** Contact point as returned by the API (URL masked) */
export type AlertContactPointPublic = Omit<AlertContactPoint, 'url'> & {
  urlMasked: string;
};

export interface AlertDeliveryRecord {
  contactPointId: string;
  contactPointName: string;
  success: boolean;
  error?: string;
  at: number;
}

/** Runtime status exposed to the dashboard */
export interface AlertRuntimeStatus {
  enabled: boolean;
  persistence: AlertPersistence;
  listenerCount: number;
  listeners: Array<{ queue: string; connected: boolean }>;
  healthCheckIntervalMs: number;
  lastHealthCheckAt?: number;
  recentEvents: AlertEvent[];
  lastDeliveries: AlertDeliveryRecord[];
  defaults: {
    cooldownMs: number;
    sendResolved: boolean;
  };
}

/**
 * Queue information for API responses
 */
export interface QueueInfo {
  name: string;
  counts: {
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    prioritized: number;
    'waiting-children': number;
    paused: number;
  };
  isPaused: boolean;
  /** Active workers for this queue; null when Redis CLIENT LIST is unavailable */
  workerCount?: number | null;
}

/**
 * Worker information from BullMQ
 */
export interface WorkerInfo {
  id: string;
  name: string;
  addr: string;
  age: number; // milliseconds since worker started
  idle: number; // milliseconds since last job
  started: number; // timestamp when started
  queueName: string;
}

/**
 * Extracted tag key-value pairs from job data
 */
export type JobTags = Record<string, string | number | boolean | null>;

/**
 * Job information for API responses
 */
export interface JobInfo {
  id: string;
  name: string;
  data: unknown;
  opts: {
    attempts?: number;
    delay?: number;
    priority?: number;
  };
  progress: number | object;
  attemptsMade: number;
  processedOn?: number;
  finishedOn?: number;
  timestamp: number;
  failedReason?: string;
  stacktrace?: string[];
  returnvalue?: unknown;
  status: JobStatus;
  duration?: number;
  /** Extracted tag values from job.data based on configured tag fields */
  tags?: JobTags;
  /** Parent job info if this job is part of a flow */
  parent?: {
    id: string;
    queueName: string;
  };
}

/**
 * BullMQ job.log() entries for a single job
 */
export interface JobLogsResponse {
  logs: string[];
  count: number;
}

/**
 * Persisted span or log row of a run's timeline (dates as epoch ms)
 */
export interface RunSpanInfo {
  id: string;
  attempt: number;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  kind: 'span' | 'log';
  name: string;
  level?: string;
  status?: 'ok' | 'error';
  error?: { message: string; name?: string; stack?: string };
  startedAt: number;
  durationMs?: number;
  attributes?: Record<string, unknown>;
}

export interface JobSpansResponse {
  spans: RunSpanInfo[];
}

/**
 * Overview stats for dashboard
 */
export interface OverviewStats {
  totalJobs: number;
  activeJobs: number;
  failedJobs: number;
  completedToday: number;
  avgDuration: number;
  queues: QueueInfo[];
}

/**
 * Paginated response wrapper
 */
export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  cursor?: string;
  hasMore: boolean;
}

/**
 * Search result item
 */
export interface SearchResult {
  queue: string;
  job: JobInfo;
}

/**
 * Run item - job execution with queue context
 */
export interface RunInfo extends JobInfo {
  queueName: string;
}

/**
 * Lightweight run info for list view - only fields needed for table display
 * Excludes large fields like full job.data, opts, progress, etc.
 */
export interface RunInfoList {
  id: string;
  name: string;
  status: JobStatus;
  queueName: string;
  tags?: JobTags;
  processedOn?: number;
  timestamp: number;
  duration?: number;
  failedReason?: string;
}

/**
 * Scheduler info for repeatable jobs
 */
export interface SchedulerInfo {
  /** Job scheduler key (the id passed to upsertJobScheduler); used by "Run now". */
  key: string;
  name: string;
  queueName: string;
  pattern?: string;
  every?: number;
  next?: number;
  endDate?: number;
  tz?: string;
}

export interface DynamicScheduleInfo {
  id: string;
  type: 'DECLARATIVE' | 'IMPERATIVE';
  task: string;
  active: boolean;
  cron: string;
  timezone: string;
  externalId?: string;
  deduplicationKey?: string;
  meta: Record<string, unknown>;
  nextRun?: number;
  lastRun?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Detailed view of a single repeatable scheduler: its config plus the
 * upcoming scheduled runs and the most recent executions it produced.
 */
export interface SchedulerDetail extends SchedulerInfo {
  /** `cron` for pattern-based schedules, `interval` for a fixed `every` cadence. */
  type: 'cron' | 'interval';
  /** Upcoming scheduled run timestamps (ms epoch), soonest first. */
  upcoming: number[];
  /** Executions produced by this scheduler, most recent first. */
  recent: RunInfoList[];
}

/**
 * Delayed job info
 */
export interface DelayedJobInfo {
  id: string;
  name: string;
  queueName: string;
  delay: number;
  processAt: number;
  data: unknown;
}

/**
 * Test job request
 */
export interface TestJobRequest {
  type: TestTargetType;
  id: string;
  data: unknown;
  opts?: TestEnqueueOptions;
}

export interface TestJobResponse {
  id: string;
  type: TestTargetType;
  name: string;
  queueName: string;
}

/**
 * Sort direction
 */
export type SortDirection = 'asc' | 'desc';

/**
 * Sort options for API requests
 */
export interface SortOptions {
  field: string;
  direction: SortDirection;
}

/**
 * Valid sort fields for runs/jobs
 */
export type RunSortField =
  | 'timestamp'
  | 'name'
  | 'status'
  | 'duration'
  | 'queueName';

/**
 * Valid sort fields for repeatable schedulers
 */
export type RepeatableSortField =
  | 'name'
  | 'queueName'
  | 'pattern'
  | 'next'
  | 'tz';

/**
 * Valid sort fields for delayed schedulers
 */
export type DelayedSortField = 'name' | 'queueName' | 'processAt' | 'delay';

export type DynamicScheduleSortField =
  | 'nextRun'
  | 'lastRun'
  | 'createdAt'
  | 'updatedAt';

// ─────────────────────────────────────────────────────────────────────────────
// Metrics Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hourly bucket for metrics aggregation
 */
export interface HourlyBucket {
  /** Unix timestamp (start of hour) */
  hour: number;
  /** Number of completed jobs */
  completed: number;
  /** Number of failed jobs */
  failed: number;
  /** Average processing duration in ms */
  avgDuration: number;
  /** Average queue wait time in ms */
  avgWaitTime: number;
}

/**
 * Metrics for a single queue
 */
export interface QueueMetrics {
  queueName: string;
  buckets: HourlyBucket[];
  summary: {
    totalCompleted: number;
    totalFailed: number;
    /** Error rate as 0-1 */
    errorRate: number;
    /** Average processing duration in ms */
    avgDuration: number;
    /** Average queue wait time in ms */
    avgWaitTime: number;
    /** Average throughput per hour */
    throughputPerHour: number;
  };
}

/**
 * Slowest job entry
 */
export interface SlowestJob {
  name: string;
  queueName: string;
  duration: number;
  jobId: string;
}

/**
 * Most failing job type entry
 */
export interface FailingJobType {
  name: string;
  queueName: string;
  jobId: string;
  failCount: number;
  totalCount: number;
  errorRate: number;
  errorClass?: string;
  latestFailedReason?: string;
  latestFailedAt?: number;
  trend?: number[];
}

/**
 * Complete metrics response
 */
export interface MetricsResponse {
  /** Metrics per queue */
  queues: QueueMetrics[];
  /** Aggregated metrics across all queues */
  aggregate: Omit<QueueMetrics, 'queueName'> & { queueName: 'all' };
  /** Top 10 slowest jobs */
  slowestJobs: SlowestJob[];
  /** Top 10 most failing job types */
  mostFailingTypes: FailingJobType[];
  /** Timestamp when metrics were computed */
  computedAt: number;
}

/**
 * Error triage response for failed jobs grouped by queue, job, and error class.
 */
export interface ErrorsResponse {
  groups: FailingJobType[];
  buckets: HourlyBucket[];
  summary: QueueMetrics['summary'];
  computedAt: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A node in a flow tree representing a job and its children
 */
export interface FlowNode {
  job: JobInfo;
  queueName: string;
  children?: FlowNode[];
}

/**
 * Flow summary for list view
 */
export interface FlowSummary {
  /** Root job ID */
  id: string;
  /** Root job name */
  name: string;
  /** Queue containing root job */
  queueName: string;
  /** Root job status */
  status: JobStatus;
  /** Total number of jobs in flow */
  totalJobs: number;
  /** Number of completed jobs */
  completedJobs: number;
  /** Number of failed jobs */
  failedJobs: number;
  /** When flow was created */
  timestamp: number;
  /** Duration if completed */
  duration?: number;
}

/**
 * Request to create a test flow
 */
export interface CreateFlowRequest {
  name: string;
  queueName: string;
  data?: unknown;
  children: CreateFlowChildRequest[];
}

/**
 * Child job in a flow creation request
 */
export interface CreateFlowChildRequest {
  name: string;
  queueName: string;
  data?: unknown;
  children?: CreateFlowChildRequest[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Activity Timeline Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Activity bucket for timeline
 */
export interface ActivityBucket {
  /** Unix timestamp (start of bucket) */
  time: number;
  /** Number of completed jobs */
  completed: number;
  /** Number of failed jobs */
  failed: number;
}

/**
 * Activity stats response for the 7-day timeline
 */
export interface ActivityStatsResponse {
  /** Activity buckets (4-hour intervals over 7 days) */
  buckets: ActivityBucket[];
  /** Start time of the first bucket */
  startTime: number;
  /** End time (now) */
  endTime: number;
  /** Size of each bucket in ms */
  bucketSize: number;
  /** Total completed in period */
  totalCompleted: number;
  /** Total failed in period */
  totalFailed: number;
  /** Timestamp when stats were computed */
  computedAt: number;
}
