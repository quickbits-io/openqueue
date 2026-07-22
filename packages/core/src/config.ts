import type { AuthStrategy } from './auth';
import type { RetentionConfig } from './retention';
import type { QueueDrain, QueueStorage } from './types';
import type { QueueConcurrency } from './worker';
import type { WorldFactory } from './world';

export interface QueueConfigTaskModule {
  module: string;
  export?: string;
}

export interface OpenQueueConfig {
  namespace: string;
  dirs?: string[];
  tasks?: QueueConfigTaskModule | QueueConfigTaskModule[];
  exclude?: string[];
  /**
   * BullMQ delivery sugar. Type-only in core: `@openqueue/worker` resolves it to
   * `worldBullmq({ url, prefix, storage })` via `@openqueue/world-bullmq`. XOR
   * with `world`.
   */
  redis?: {
    url: string;
    bullPrefix?: string;
  };
  /** A non-BullMQ world (e.g. `@openqueue/world-postgres`). XOR with `redis`. */
  world?: WorldFactory;
  storage?: QueueStorage;
  drains?: QueueDrain[];
  /**
   * Age-based pruning of durable run history (defaults 30/90/30 days; see
   * {@link RetentionConfig}). Swept hourly through the store's optional
   * `prune` — stores without it are left untouched.
   */
  retention?: RetentionConfig;
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
    /** Basic credentials (sugar for `[httpBasic(...)]`) or an ordered
     *  {@link AuthStrategy} walk. Unset = dashboard open (existing behavior). */
    auth?: { username: string; password: string } | AuthStrategy[];
    tagFields?: string[];
  };
  api?: {
    /** Bearer token(s) for the /openqueue/v1 control API — sugar for a leading
     *  `apiKey()` strategy. When neither `token` nor `auth` is set, the API is
     *  open in development and locked (401) when NODE_ENV=production. */
    token?: string | string[];
    /** Ordered {@link AuthStrategy} walk for /openqueue/v1. Empty array = always
     *  401 (fail-closed). With `token` also set, the token check runs first. */
    auth?: AuthStrategy[];
  };
  build?: {
    outDir?: string;
    extraFiles?: string[];
    external?: string[];
    /** Emit .map files alongside the artifact bundle (e.g. for Sentry
     *  symbolication). Off by default — maps add tens of MB to `.output`;
     *  upload them, then strip them from the deployed image. */
    sourcemap?: boolean;
  };
}

export function defineConfig(config: OpenQueueConfig): OpenQueueConfig {
  return config;
}
