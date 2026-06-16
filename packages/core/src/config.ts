import type { Attributes } from '@opentelemetry/api';
import type { SpanExporter } from '@opentelemetry/sdk-trace-base';
import type { BackoffOptions, QueueDrain, QueueStorage } from './types';
import type { QueueConcurrency } from './worker';

export interface QueueConfigTaskModule {
  module: string;
  export?: string;
}

export interface QueueConfig {
  namespace: string;
  dirs?: string[];
  tasks?: QueueConfigTaskModule | QueueConfigTaskModule[];
  exclude?: string[];
  redis: {
    url: string;
    bullPrefix?: string;
  };
  storage?: {
    adapter: QueueStorage;
  };
  drains?: QueueDrain[];
  concurrency?: {
    global?: number;
    queues?: QueueConcurrency;
  };
  metrics?: {
    enabled?: boolean;
    prefix?: string;
  };
  workbench?: {
    enabled?: boolean;
    title?: string;
    basePath?: string;
    readonly?: boolean;
    auth?: {
      username: string;
      password: string;
    };
    tagFields?: string[];
  };
  build?: {
    outDir?: string;
    extraFiles?: string[];
    external?: string[];
  };
}

export type OpenQueueConfig = QueueConfig;

export function defineConfig(config: OpenQueueConfig): OpenQueueConfig {
  return config;
}

export interface TelemetryConfig {
  /**
   * OpenTelemetry resource attributes. `service.name` and
   * `deployment.environment` are auto-populated from the top-level config.
   */
  resource?: Attributes;

  /**
   * Pre-built span exporters. Pass one or more OTLPTraceExporter/
   * ConsoleSpanExporter/etc. instances — the bootstrap wraps them in a
   * BatchSpanProcessor and registers a global tracer provider.
   *
   * If omitted, spans are emitted into the process's existing tracer provider
   * (set up elsewhere) or dropped if none exists.
   */
  exporters?: SpanExporter[];

  /**
   * Whether to propagate trace context across enqueue → process via the
   * `__otel` carrier on job meta. Defaults to true.
   */
  propagateContext?: boolean;
}

export interface WorkerConfig {
  /** service.name resource attribute. Required. */
  serviceName: string;

  /** deployment.environment resource attribute. Defaults to NODE_ENV. */
  environment?: string;

  /** OTel drain / resource config. Omit to skip tracing entirely. */
  telemetry?: TelemetryConfig;

  /** Queue defaults applied to every job unless overridden per-definition. */
  defaults?: {
    attempts?: number;
    backoff?: BackoffOptions;
  };

  /** Toggle the pretty-printed lifecycle console logger. Default: true. */
  console?: boolean;
}

/**
 * Identity helper that preserves the `WorkerConfig` type. Use in
 * `worker.config.ts` so your editor gives you autocomplete + type errors:
 *
 *   import { defineWorkerConfig } from '@openqueue/sdk/config';
 *   export default defineWorkerConfig({ ... });
 */
export function defineWorkerConfig(config: WorkerConfig): WorkerConfig {
  return config;
}
