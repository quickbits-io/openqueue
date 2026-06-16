import { randomUUID } from 'node:crypto';
import {
  type Context,
  createContextKey,
  type HrTime,
  SpanStatusCode,
} from '@opentelemetry/api';
import type {
  ReadableSpan,
  Span,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import type { QueueRunSpan, QueueSpanStore } from './types';

const RUN_ID_KEY = createContextKey('openqueue.run.id');
const ATTEMPT_KEY = createContextKey('openqueue.attempt');

const FLUSH_INTERVAL_MS = 2000;
const MAX_BUFFERED_ROWS = 5000;

/**
 * Stamps the run identity onto a context so every span started under it
 * (attempt span, ctx.withSpan children, instrumented fetch calls, user
 * tracer spans) is attributed to the run by the workbench span processor.
 */
export function withRunContext(
  ctx: Context,
  runId: string,
  attempt: number,
): Context {
  return ctx.setValue(RUN_ID_KEY, runId).setValue(ATTEMPT_KEY, attempt);
}

/**
 * SpanProcessor that persists run-scoped spans (and their events as log
 * rows) to a QueueSpanStore. Inert until a store is attached: onStart/onEnd
 * return immediately, so nothing is collected or buffered when persistence
 * isn't configured. Writes are batched and never throw into the caller.
 */
class WorkbenchSpanProcessor implements SpanProcessor {
  private store: QueueSpanStore | null = null;
  private buffer: QueueRunSpan[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private flushing: Promise<void> = Promise.resolve();

  attach(store: QueueSpanStore): void {
    this.store = store;
    if (!this.timer) {
      this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  onStart(span: Span, parentContext: Context): void {
    if (!this.store) return;
    const runId = parentContext.getValue(RUN_ID_KEY);
    if (typeof runId !== 'string') return;
    span.setAttribute('run.id', runId);
    const attempt = parentContext.getValue(ATTEMPT_KEY);
    if (typeof attempt === 'number') {
      span.setAttribute('task.attempt', attempt);
    }
  }

  onEnd(span: ReadableSpan): void {
    if (!this.store) return;
    const runId = span.attributes['run.id'];
    if (typeof runId !== 'string') return;
    if (this.buffer.length >= MAX_BUFFERED_ROWS) return;
    this.buffer.push(...spanRows(span, runId));
  }

  forceFlush(): Promise<void> {
    return this.flush();
  }

  shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.flush();
  }

  private flush(): Promise<void> {
    this.flushing = this.flushing.then(async () => {
      const store = this.store;
      if (!store || this.buffer.length === 0) return;
      const rows = this.buffer;
      this.buffer = [];
      try {
        await store.insertMany(rows);
      } catch (err) {
        console.error('[openqueue] failed to persist run spans', err);
      }
    });
    return this.flushing;
  }
}

let processor: WorkbenchSpanProcessor | null = null;

/**
 * Singleton processor to register via the tracer provider (e.g. initOtel's
 * extraSpanProcessors). Harmless when no store is ever attached.
 */
export function workbenchSpanProcessor(): SpanProcessor {
  processor ??= new WorkbenchSpanProcessor();
  return processor;
}

/** Activates span persistence. Called by the worker runtime when the configured storage supports spans. */
export function attachSpanStore(store: QueueSpanStore): void {
  (workbenchSpanProcessor() as WorkbenchSpanProcessor).attach(store);
}

function spanRows(span: ReadableSpan, runId: string): QueueRunSpan[] {
  const attemptAttr = span.attributes['task.attempt'];
  const attempt = typeof attemptAttr === 'number' ? attemptAttr : 1;
  const { traceId, spanId } = span.spanContext();

  const rows: QueueRunSpan[] = [
    {
      id: randomUUID(),
      runId,
      attempt,
      traceId,
      spanId,
      parentSpanId: span.parentSpanContext?.spanId,
      kind: 'span',
      name: span.name,
      status:
        span.status.code === SpanStatusCode.ERROR
          ? 'error'
          : span.status.code === SpanStatusCode.OK
            ? 'ok'
            : undefined,
      error: spanError(span),
      startedAt: hrTimeToDate(span.startTime),
      durationMs: Math.round(hrTimeToMs(span.duration)),
      attributes: span.attributes as Record<string, unknown>,
    },
  ];

  for (const event of span.events) {
    // Exceptions are folded into the span row's error field above
    if (event.name === 'exception') continue;
    const level = event.attributes?.['log.level'];
    rows.push({
      id: randomUUID(),
      runId,
      attempt,
      traceId,
      spanId,
      parentSpanId: spanId,
      kind: 'log',
      name: event.name,
      level: typeof level === 'string' ? level : undefined,
      startedAt: hrTimeToDate(event.time),
      attributes: event.attributes as Record<string, unknown> | undefined,
    });
  }

  return rows;
}

function spanError(span: ReadableSpan): QueueRunSpan['error'] {
  if (span.status.code !== SpanStatusCode.ERROR) return undefined;
  const exception = [...span.events]
    .reverse()
    .find((event) => event.name === 'exception');
  const attrs = exception?.attributes;
  const message =
    stringAttr(attrs?.['exception.message']) ??
    span.status.message ??
    'Unknown error';
  return {
    message,
    name: stringAttr(attrs?.['exception.type']),
    stack: stringAttr(attrs?.['exception.stacktrace']),
  };
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function hrTimeToMs(time: HrTime): number {
  return time[0] * 1000 + time[1] / 1e6;
}

function hrTimeToDate(time: HrTime): Date {
  return new Date(hrTimeToMs(time));
}
