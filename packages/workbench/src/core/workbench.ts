import type { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { AlertManager } from './alert-manager';
import { createAlertStore } from './alert-store';
import { discoverQueues } from './discover';
import { QueueManager } from './queue-manager';
import type {
  AlertPersistence,
  WorkbenchCapabilities,
  WorkbenchOptions,
} from './types';

/**
 * Internal metadata produced by {@link WorkbenchCore.fromOptions} when queues
 * are auto-discovered from a Redis connection.
 */
export interface DiscoveryMeta {
  /** Total number of queues found on the connection (before capping). */
  total: number;
  /** True if the result was capped at `maxQueues`. */
  capped: boolean;
  /** The cap that was applied. */
  cap: number;
}

/**
 * Core Workbench class that manages the dashboard
 */
export class WorkbenchCore {
  readonly options: Required<Pick<WorkbenchOptions, 'title' | 'readonly'>> &
    WorkbenchOptions;
  readonly queueManager: QueueManager;
  readonly discovery: DiscoveryMeta | null;
  readonly alertManager: AlertManager | null;
  readonly alertsPersistence: AlertPersistence | null;
  readonly capabilities: WorkbenchCapabilities;

  constructor(
    options: WorkbenchOptions | Queue[],
    discovery: DiscoveryMeta | null = null,
  ) {
    const opts = Array.isArray(options) ? { queues: options } : options;

    this.options = {
      title: 'Workbench',
      readonly: false,
      ...opts,
    };

    this.discovery = discovery;
    this.capabilities = {
      storage: !!this.options.queue,
      dynamicSchedules: !!this.options.queue?.schedules,
      dynamicScheduleMutations:
        !!this.options.queue?.schedules && !this.options.readonly,
      postgresAlerts: this.options.alerts?.persistence === 'postgres',
      spans: !!this.options.queue?.spans,
    };

    const explicit = this.options.queues ?? [];

    // An explicit empty `queues: []` is intentional (a non-BullMQ world with no
    // queues to display); only a wholly absent `queues` with no `redis` to
    // auto-discover from is a misconfiguration.
    if (this.options.queues === undefined && !this.options.redis) {
      throw new Error(
        'Workbench requires at least one queue. Pass queues directly or provide a redis connection for auto-discovery.',
      );
    }

    this.queueManager = new QueueManager(
      explicit,
      this.options.tagFields || [],
      this.options.registry,
    );

    if (this.options.alerts?.enabled !== false) {
      const alertsOpts = this.options.alerts ?? {};
      const queueConnection = explicit[0]?.opts?.connection;
      const { store, persistence } = createAlertStore(alertsOpts, {
        queueConnection,
        redis: this.options.redis,
        prefix: this.options.prefix ?? 'bull',
      });
      this.alertsPersistence = persistence;
      this.alertManager = new AlertManager(
        this.queueManager,
        () => this.queueManager.getQueueMap(),
        alertsOpts,
        store,
        persistence,
      );
      if (alertsOpts.delivery !== false) {
        void this.alertManager.start().catch((err) => {
          console.error('[workbench] Failed to start alert manager:', err);
        });
      }
    } else {
      this.alertsPersistence = null;
      this.alertManager = null;
    }
  }

  /**
   * Async factory: build a `WorkbenchCore` from `WorkbenchOptions`, performing
   * BullMQ queue auto-discovery via `SCAN <prefix>:*:meta` when `queues` is
   * not provided.
   *
   * - When `queues` is set explicitly, behaves like `new WorkbenchCore(opts)`.
   * - When only `redis` is set, scans the connection for queues, caps at
   *   `maxQueues` (default 100) to avoid connection storms with very large
   *   deployments, and constructs the core with the resulting list.
   * - When no queues are discovered, the core is constructed with an empty
   *   queue map so the dashboard can render an "empty" state instead of
   *   erroring out.
   */
  static async fromOptions(opts: WorkbenchOptions): Promise<WorkbenchCore> {
    if (opts.queues?.length) {
      return new WorkbenchCore(opts);
    }
    if (!opts.redis) {
      throw new Error(
        'WorkbenchCore.fromOptions requires either `queues` or `redis`',
      );
    }

    const prefix = opts.prefix ?? 'bull';
    const cap = opts.maxQueues ?? 100;
    const all = await discoverQueues(opts.redis, prefix);
    const queues = all.slice(0, cap);

    return new WorkbenchCore(
      { ...opts, queues },
      { total: all.length, capped: all.length > cap, cap },
    );
  }

  /**
   * Get the queue manager instance
   */
  getQueueManager(): QueueManager {
    return this.queueManager;
  }

  /**
   * Check if authentication is required. The credentials form requires both a
   * username and password; the strategy-array form always requires auth
   * (fail-closed, including the empty array).
   */
  requiresAuth(): boolean {
    const auth = this.options.auth;
    if (auth === undefined) return false;
    if (Array.isArray(auth)) return true;
    return !!(auth.username && auth.password);
  }

  /**
   * Validate a username/password against the credentials form. The
   * strategy-array form is not username/password based and always fails here —
   * those requests authenticate through the auth walk instead.
   */
  validateAuth(username: string, password: string): boolean {
    const auth = this.options.auth;
    if (auth === undefined) return true;
    if (Array.isArray(auth)) return false;
    return username === auth.username && password === auth.password;
  }

  /**
   * Get dashboard configuration for the UI
   */
  getConfig() {
    return {
      title: this.options.title,
      logo: this.options.logo,
      readonly: this.options.readonly,
      queues: this.queueManager.getQueueNames(),
      tagFields: this.queueManager.getTagFields(),
      discovery: this.discovery,
      alertsEnabled: this.alertManager !== null,
      alertsPersistence: this.alertsPersistence,
      capabilities: this.capabilities,
      registry: this.queueManager.getRegistryConfig(),
    };
  }
}

// Re-export for convenience: callers using `WorkbenchOptions.redis` can also
// import the underlying connection type without depending on `bullmq` directly.
export type { RedisOptions };
