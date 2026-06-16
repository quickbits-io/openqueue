import {
  type Attributes,
  context,
  propagation,
  SpanKind,
  trace,
} from '@opentelemetry/api';

const TRACE_CARRIER_KEY = '__otel';

type Carrier = Record<string, string>;

/**
 * Captures the current trace context into a carrier object suitable for
 * attaching to job metadata at enqueue time. Use when building `meta` for
 * enqueue() so the worker's span becomes a child of the caller's span.
 */
export function captureTraceCarrier(): Carrier | undefined {
  const carrier: Carrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

/**
 * Synthesizes a root "run" span (0-duration) and returns its context as a
 * carrier. Use when no ambient trace context exists at enqueue time so that
 * every attempt of the same run becomes a sibling child of a shared parent
 * in the trace waterfall (mirrors Trigger.dev's `run` → `attempt.N` shape).
 */
export function startRunSpan(
  name: string,
  attributes?: Attributes,
): Carrier | undefined {
  const tracer = trace.getTracer('@openqueue/sdk', '0.1.0');
  const span = tracer.startSpan(name, {
    kind: SpanKind.CONSUMER,
    attributes,
  });
  const ctx = trace.setSpan(context.active(), span);
  const carrier: Carrier = {};
  propagation.inject(ctx, carrier);
  span.end();
  return Object.keys(carrier).length > 0 ? carrier : undefined;
}

export const traceCarrierKey = TRACE_CARRIER_KEY;
