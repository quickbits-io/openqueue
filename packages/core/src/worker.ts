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
import {
  isMaxDurationExceeded,
  isNonRetryable,
  MaxDurationExceededError,
  NonRetryableError,
  serializeError,
} from './errors';
import { withJobLogs } from './job-logs';
import { consoleLogger } from './logger';
import { buildSnapshot, unwrapInput } from './snapshot';
import { withRunContext } from './span-export';
import { trigger as moduleTrigger } from './task';
import type {
  ActiveTransportJob,
  ConsumeOptions,
  TransportConsumer,
} from './transport/types';
import type {
  EnqueueOptions,
  EnqueueResult,
  QueueDrain,
  QueueRunSnapshot,
  TaskContext,
  TaskDefinition,
} from './types';

export type QueueConcurrency = Record<string, number>;

/** `ctx.trigger` bound to a specific runtime's enqueue path. */
type QueueTrigger = <I, O = unknown>(
  target: string | TaskDefinition<I, O>,
  input: I,
  opts?: EnqueueOptions,
) => Promise<EnqueueResult>;

export interface WorkerConsumerOptions {
  drain?: QueueDrain;
  globalConcurrency?: number;
  queueConcurrency?: QueueConcurrency;
  /**
   * The runtime's own `trigger`, threaded into `ctx.trigger` so a job's
   * enqueues land in this runtime's world — not whichever runtime last called
   * the module-global `bindQueueRuntime`. Falls back to that global for direct
   * (single-runtime) callers that don't pass it.
   */
  trigger?: QueueTrigger;
}

export interface WorkerGroup {
  queue: string;
  jobs: TaskDefinition[];
  concurrency: number;
  maxStalledCount?: number;
  maxDuration?: number;
}

/**
 * Headroom added to a queue's longest task budget when sizing the transport
 * lease: the 30s stall tolerance both first-party worlds default to, so a task
 * that spends its whole budget still settles inside its delivery lock.
 */
const LEASE_HEADROOM_MS = 30_000;

const TRACER_NAME = '@openqueue/sdk';
const TRACER_VERSION = '0.1.0';

export function createWorkerConsumers<C extends TransportConsumer>(
  jobs: TaskDefinition[],
  transport: { id: string; consume(queue: string, options: ConsumeOptions): C },
  options: WorkerConsumerOptions = {},
): C[] {
  const drain = composeDrains(options.drain);
  const limiter = createLimiter(options.globalConcurrency);
  const groups = groupJobsByQueue(jobs, options.queueConcurrency);
  const trigger = options.trigger ?? moduleTrigger;
  const transportId = transport.id;

  return groups.map(
    ({
      queue: queueName,
      jobs: defs,
      concurrency,
      maxStalledCount,
      maxDuration,
    }) => {
      const defByName = new Map(defs.map((d) => [d.name, d]));
      // Attempts that blew their budget, handed from `process` to `onFailed`:
      // the BullMQ world replaces the thrown error with its own
      // `UnrecoverableError`, so the outcome cannot ride on the error object.
      const overBudget = new Set<string>();

      return transport.consume(queueName, {
        concurrency,
        ...(maxStalledCount !== undefined ? { maxStalledCount } : {}),
        ...(maxDuration !== undefined
          ? { lockDuration: maxDuration + LEASE_HEADROOM_MS }
          : {}),
        isFinal: isNonRetryable,
        process: async (job) => {
          // Captured before the limiter so Dequeued → Started exposes time
          // spent waiting on global concurrency plus run setup.
          const dequeuedAt = Date.now();
          try {
            return await limiter(() =>
              runJob(job, defByName, drain, dequeuedAt, trigger, transportId),
            );
          } catch (err) {
            if (isMaxDurationExceeded(err)) overBudget.add(attemptKey(job));
            throw err;
          }
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
          const timedOut = overBudget.delete(attemptKey(job));
          const snapshot: QueueRunSnapshot = {
            ...buildSnapshot({
              job,
              def,
              status: willRetry
                ? 'reattempting'
                : timedOut
                  ? 'timed_out'
                  : 'failed',
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
    // A queue has one consumer, so each option collapses to the value that
    // protects the whole lane: the fewest stall recoveries any task tolerates,
    // and the longest budget any task is allowed.
    maxStalledCount: minDefined(defs.map((d) => d.maxStalledCount)),
    maxDuration: maxDefined(defs.map((d) => d.maxDuration)),
  }));
}

function minDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter(
    (value): value is number => value !== undefined,
  );
  if (defined.length === 0) return undefined;
  return Math.min(...defined);
}

function maxDefined(values: Array<number | undefined>): number | undefined {
  const defined = values.filter(
    (value): value is number => value !== undefined,
  );
  if (defined.length === 0) return undefined;
  return Math.max(...defined);
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
  trigger: QueueTrigger,
  transportId: string,
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
    'messaging.system': transportId,
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
        return await withJobLogs(job, async () =>
          def.maxDuration === undefined
            ? def.handler(ctx)
            : withMaxDuration(def.handler(ctx), def.maxDuration, controller),
        );
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

/**
 * Race a running handler against its task's `maxDuration` budget. Cancellation
 * is cooperative: the budget aborts `ctx.signal`, but an in-process handler
 * that ignores the signal keeps running to completion — its result (or late
 * rejection) is discarded, because the attempt's promise has already settled.
 */
function withMaxDuration<T>(
  running: Promise<T>,
  maxDuration: number,
  controller: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new MaxDurationExceededError(maxDuration));
    }, maxDuration);
    // Settles the race for a handler that finishes in time, and absorbs the
    // late rejection of one that does not — nothing awaits it any more.
    void running.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Ties one job's `process` call to the lifecycle callbacks that follow it. */
function attemptKey(job: ActiveTransportJob): string {
  return job.id ?? job.name;
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
