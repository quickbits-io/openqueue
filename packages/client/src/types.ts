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

export interface BackoffOptions {
  type: 'exponential' | 'fixed';
  delay: number;
}

/** Mirror of core's `RunPrincipal` — identity stamped onto `meta.enqueuedBy`. */
export interface RunPrincipal {
  authenticator: string;
  principalId: string;
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
  ttl?: number;
  failParentOnFailure?: boolean;
  continueParentOnFailure?: boolean;
  ignoreDependencyOnFailure?: boolean;
  meta?: EnqueueMeta;
}

export interface EnqueueResult {
  id: string;
  runId: string;
  jobId: string;
  transportJobId: string;
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
  /** Deep-containment filter over `meta` (Postgres `@>` semantics). */
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

export interface QueueRunPollOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
}

export type CancelRunResult =
  | { outcome: 'canceled'; run: QueueRun }
  | { outcome: 'not_found' }
  | { outcome: 'already_finished'; run: QueueRun }
  | { outcome: 'not_cancelable'; run: QueueRun; reason: 'executing' };

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

export interface QueueScheduleListOptions {
  task?: string;
  externalId?: string;
  active?: boolean;
  /** Deep-containment filter over `meta` (Postgres `@>` semantics). */
  meta?: Record<string, unknown>;
  sort?: {
    field: 'nextRun' | 'lastRun' | 'createdAt' | 'updatedAt';
    direction: 'asc' | 'desc';
  };
  limit?: number;
  cursor?: string;
}

export interface QueueCatalogEntry {
  id: string;
  name: string;
  queue: string;
  attempts: number;
  backoff: BackoffOptions;
  concurrency: number;
  ttl?: number;
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

/** Structural supertype of core's TaskDefinition — accepts any task() value. */
export interface TaskRef<I = unknown, O = unknown> {
  id: string;
  schema?: { parse(input: unknown): I };
  __input?: I;
  __output?: O;
}

export interface CreateScheduleOptions {
  task: string | TaskRef;
  input?: unknown;
  cron: string;
  timezone?: string;
  externalId?: string;
  deduplicationKey: string;
  meta?: EnqueueMeta;
}

export interface UpdateScheduleOptions {
  task?: string | TaskRef;
  input?: unknown;
  cron?: string;
  timezone?: string;
  externalId?: string | null;
  deduplicationKey?: string;
  meta?: EnqueueMeta;
}

export interface WorkerInfo {
  service: 'openqueue';
  apiVersion: 1;
  namespace: string;
  tasks: number;
  queues: string[];
}
