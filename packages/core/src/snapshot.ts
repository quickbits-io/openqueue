import type { ActiveTransportJob } from './transport/types';
import type {
  EnqueueMeta,
  QueueRunSnapshot,
  RunStatus,
  TaskDefinition,
} from './types';

interface BuildArgs {
  job: ActiveTransportJob;
  def: TaskDefinition;
  status: RunStatus;
  willRetry?: boolean;
}

export function buildSnapshot({
  job,
  def,
  status,
  willRetry = false,
}: BuildArgs): QueueRunSnapshot {
  const rawData = (job.data ?? {}) as {
    __input?: unknown;
    __runId?: string;
    __meta?: EnqueueMeta;
    __metadata?: Record<string, unknown>;
    __otel?: Record<string, string>;
  };

  const input = unwrapInput(rawData);
  const meta = rawData.__meta ?? {};
  const metadata = rawData.__metadata ?? {};
  const traceCarrier = rawData.__otel;

  const createdAt = new Date(job.timestamp);
  const startedAt =
    typeof job.processedOn === 'number' ? new Date(job.processedOn) : undefined;
  const finishedAt =
    typeof job.finishedOn === 'number' ? new Date(job.finishedOn) : undefined;
  const delayedUntil =
    job.opts.delay !== undefined
      ? new Date(job.timestamp + job.opts.delay)
      : undefined;

  const durationMs =
    startedAt && finishedAt
      ? finishedAt.getTime() - startedAt.getTime()
      : undefined;

  return {
    id: rawData.__runId ?? job.id ?? '',
    transportJobId: job.id ?? undefined,
    name: job.name,
    queue: job.queueName,
    status,
    input,
    output: job.returnvalue ?? undefined,
    meta,
    metadata,
    tags: meta.tags ?? def.tags ?? [],
    scheduleId: stringOrUndef(meta.scheduleId),
    scheduleExternalId: stringOrUndef(meta.scheduleExternalId),
    attempt: Math.max(job.attemptsMade, 1),
    maxAttempts: job.opts.attempts ?? def.attempts,
    willRetry,
    parentRunId: stringOrUndef(meta.parentRunId),
    createdAt,
    queuedAt: createdAt,
    startedAt,
    finishedAt,
    delayedUntil,
    durationMs,
    traceCarrier,
  };
}

function stringOrUndef(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Recover a job's task input from its transport envelope.
 *
 * The enqueuer wraps input as `{ __input, __runId, __meta, __metadata }`. A job
 * whose input was `undefined` serializes to an envelope with **no** `__input`
 * key — JSON (Postgres jsonb, BullMQ) drops `undefined` values — so the key's
 * absence alone cannot distinguish "undefined input" from a raw, externally
 * enqueued job. Detect our envelope by its always-present `__runId` + `__metadata`
 * markers and return `undefined`; anything without them is treated as raw data
 * and returned as-is.
 */
export function unwrapInput(data: unknown): unknown {
  if (data && typeof data === 'object') {
    if ('__input' in data) return (data as { __input: unknown }).__input;
    if ('__runId' in data && '__metadata' in data) return undefined;
  }
  return data;
}
