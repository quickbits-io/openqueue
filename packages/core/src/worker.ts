import { randomUUID } from 'node:crypto';
import {
  type Attributes,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api';
import { composeDrains } from './compose';
import { isNonRetryable, NonRetryableError, serializeError } from './errors';
import { withJobLogs } from './job-logs';
import { consoleLogger } from './logger';
import { buildSnapshot } from './snapshot';
import { withRunContext } from './span-export';
import { trigger } from './task';
import type {
  ActiveTransportJob,
  ConsumeOptions,
  TransportConsumer,
} from './transport/types';
import type {
  QueueDrain,
  QueueRunSnapshot,
  TaskContext,
  TaskDefinition,
} from './types';

export type QueueConcurrency = Record<string, number>;

export interface WorkerConsumerOptions {
  drain?: QueueDrain;
  globalConcurrency?: number;
  queueConcurrency?: QueueConcurrency;
}

export interface WorkerGroup {
  queue: string;
  jobs: TaskDefinition[];
  concurrency: number;
  maxStalledCount?: number;
}

const TRACER_NAME = '@openqueue/sdk';
const TRACER_VERSION = '0.1.0';

export function createWorkerConsumers<C extends TransportConsumer>(
  jobs: TaskDefinition[],
  transport: { consume(queue: string, options: ConsumeOptions): C },
  options: WorkerConsumerOptions = {},
): C[] {
  const drain = composeDrains(options.drain);
  const limiter = createLimiter(options.globalConcurrency);
  const groups = groupJobsByQueue(jobs, options.queueConcurrency);

  return groups.map(
    ({ queue: queueName, jobs: defs, concurrency, maxStalledCount }) => {
      const defByName = new Map(defs.map((d) => [d.name, d]));

      return transport.consume(queueName, {
        concurrency,
        ...(maxStalledCount !== undefined ? { maxStalledCount } : {}),
        isFinal: isNonRetryable,
        process: (job) => {
          // Captured before the limiter so Dequeued → Started exposes time
          // spent waiting on global concurrency plus run setup.
          const dequeuedAt = Date.now();
          return limiter(() => runJob(job, defByName, drain, dequeuedAt));
        },
        onCompleted: async (job) => {
          const def = defByName.get(job.name);
          if (!def) return;
          await ensureRunIdentity(job);
          const snapshot = buildSnapshot({ job, def, status: 'completed' });
          await drain.handle({ type: 'complete', run: snapshot });
        },
        onFailed: async (job, err, { final }) => {
          if (!job) return;
          const def = defByName.get(job.name);
          if (!def) return;
          await ensureRunIdentity(job);
          const willRetry =
            !final && job.attemptsMade < (job.opts.attempts ?? 0);
          const snapshot: QueueRunSnapshot = {
            ...buildSnapshot({
              job,
              def,
              status: willRetry ? 'reattempting' : 'failed',
              willRetry,
            }),
            error: serializeError(err, { retryable: !final }),
          };
          await drain.handle({ type: 'fail', run: snapshot });
        },
        onError: (err) => {
          console.error(`[queue] worker "${queueName}" error`, err);
        },
      });
    },
  );
}

export function groupJobsByQueue(
  jobs: TaskDefinition[],
  queueConcurrency?: QueueConcurrency,
): WorkerGroup[] {
  const byQueue = new Map<string, TaskDefinition[]>();
  for (const def of jobs) {
    const list = byQueue.get(def.queue) ?? [];
    list.push(def);
    byQueue.set(def.queue, list);
  }

  return Array.from(byQueue.entries()).map(([queue, defs]) => ({
    queue,
    jobs: defs,
    concurrency: positiveInt(
      queueConcurrency?.[queue] ?? Math.max(...defs.map((d) => d.concurrency)),
    ),
    maxStalledCount: minDefined(defs.map((d) => d.maxStalledCount)),
  }));
}

function minDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter(
    (value): value is number => value !== undefined,
  );
  if (defined.length === 0) return undefined;
  return Math.min(...defined);
}

export function createLimiter(limit?: number) {
  const max = positiveInt(limit ?? Number.POSITIVE_INFINITY);
  let active = 0;
  const waiting: Array<() => void> = [];

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

function positiveInt(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.max(Math.floor(value), 1);
}

async function runJob(
  job: ActiveTransportJob,
  defByName: Map<string, TaskDefinition>,
  drain: QueueDrain,
  dequeuedAt: number,
): Promise<unknown> {
  const def = defByName.get(job.name);
  if (!def) {
    // Non-retryable: the transport converts this into a permanent failure.
    throw new NonRetryableError(`No handler registered for job: ${job.name}`);
  }

  await ensureRunIdentity(job);
  const rawInput = unwrapInput(job.data);
  const input = def.schema ? def.schema.parse(rawInput) : rawInput;
  if (def.schema && job.data && typeof job.data === 'object') {
    await job.updateData({ ...job.data, __input: input });
  }
  const attempt = Math.max(job.attemptsMade + 1, 1);
  const maxAttempts = job.opts.attempts ?? def.attempts;
  const controller = new AbortController();

  const rawMeta =
    (job.data as { __meta?: Record<string, unknown> } | undefined)?.__meta ??
    {};

  const snapshot = buildSnapshot({
    job,
    def,
    status: attempt > 1 ? 'reattempting' : 'executing',
  });

  const baseLogger = consoleLogger(`${def.name}#${snapshot.id}`);
  const tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
  const ctx: TaskContext = {
    id: snapshot.id,
    transportJobId: snapshot.transportJobId,
    name: job.name,
    input,
    tags: Array.isArray(rawMeta.tags) ? (rawMeta.tags as string[]) : def.tags,
    attempt: { number: attempt, max: maxAttempts },
    signal: controller.signal,
    logger: baseLogger,
    trigger,
    progress: async (patch) => {
      const current =
        (job.data as { __metadata?: Record<string, unknown> } | undefined)
          ?.__metadata ?? {};
      const nextMetadata = deepMerge(current, patch);
      await job.updateData({ ...(job.data ?? {}), __metadata: nextMetadata });
      await job.updateProgress(nextMetadata);
      const active = trace.getActiveSpan();
      if (active) active.addEvent('progress', flattenProgress(patch));
      const next = {
        ...buildSnapshot({ job, def, status: 'executing' }),
        metadata: nextMetadata,
      };
      await drain.handle({ type: 'progress', run: next, patch });
    },
    withSpan: async (name, fn, attributes) =>
      tracer.startActiveSpan(name, { attributes }, async (span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          recordSpanError(span, err);
          throw err;
        } finally {
          span.end();
        }
      }),
  };

  await drain.handle({ type: 'start', run: snapshot });

  const parentContext =
    snapshot.traceCarrier && Object.keys(snapshot.traceCarrier).length > 0
      ? propagation.extract(context.active(), snapshot.traceCarrier)
      : context.active();
  const attemptName = `Attempt ${attempt}`;
  const attemptAttrs: Attributes = {
    'messaging.system': 'bullmq',
    'messaging.destination.name': def.queue,
    'messaging.operation': 'process',
    'messaging.message.id': job.id ?? '',
    'run.id': snapshot.id,
    'task.name': def.name,
    'task.attempt': attempt,
    'task.max_attempts': maxAttempts,
    'attempt.dequeued_at': dequeuedAt,
    ...(ctx.tags.length > 0 ? { 'job.tags': ctx.tags } : {}),
  };

  return await tracer.startActiveSpan(
    attemptName,
    { kind: SpanKind.CONSUMER, attributes: attemptAttrs },
    withRunContext(parentContext, snapshot.id, attempt),
    async (attemptSpan) => {
      let errored = false;
      try {
        return await withJobLogs(job, async () => def.handler(ctx));
      } catch (err) {
        errored = true;
        recordSpanError(attemptSpan, err);
        // Rethrow the original error; the transport decides retry vs. final.
        throw err;
      } finally {
        if (!errored) attemptSpan.setStatus({ code: SpanStatusCode.OK });
        attemptSpan.end();
        await forceFlush();
      }
    },
  );
}

async function ensureRunIdentity(job: ActiveTransportJob): Promise<void> {
  const data = job.data;
  if (
    data &&
    typeof data === 'object' &&
    typeof (data as { __runId?: unknown }).__runId === 'string'
  ) {
    return;
  }

  const next =
    data && typeof data === 'object'
      ? { ...data, __runId: randomUUID() }
      : { __input: data, __runId: randomUUID(), __meta: {}, __metadata: {} };
  await job.updateData(next);
}

function recordSpanError(span: Span, err: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
  if (err instanceof Error) span.recordException(err);
}

async function forceFlush(): Promise<void> {
  const provider = trace.getTracerProvider() as unknown as {
    getDelegate?: () => { forceFlush?: () => Promise<void> };
    forceFlush?: () => Promise<void>;
  };
  const target = provider.getDelegate?.() ?? provider;
  await target.forceFlush?.().catch(() => undefined);
}

function unwrapInput(data: unknown): unknown {
  if (data && typeof data === 'object' && '__input' in data) {
    return (data as { __input: unknown }).__input;
  }
  return data;
}

function flattenProgress(patch: unknown): Attributes {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { 'job.progress': JSON.stringify(patch) };
  }
  const out: Attributes = {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[`progress.${key}`] = value;
    } else if (value !== undefined && value !== null) {
      out[`progress.${key}`] = JSON.stringify(value);
    }
  }
  return out;
}

function deepMerge(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = out[key];
    if (
      prev &&
      typeof prev === 'object' &&
      !Array.isArray(prev) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = deepMerge(
        prev as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
}
