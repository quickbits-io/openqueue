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

  const input = '__input' in rawData ? rawData.__input : rawData;
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
