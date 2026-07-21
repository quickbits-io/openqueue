import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  consoleDrain,
  createQueueWorker,
  defineQueueTasks,
  getRegisteredTasks,
  loadQueueTasks,
  type OpenQueueConfig,
  type QueueCatalogEntry,
  type QueueConfigTaskModule,
  type QueueTaskDiscovery,
  type QueueWorkerRuntime,
  type TaskDefinition,
  validateTaskDefinitions,
  type WorldFactory,
} from '@openqueue/core';
import {
  resolveControlAuth,
  WorkbenchCore,
  type WorkbenchJobDefinition,
} from '@openqueue/workbench';
import { buildControlApp, buildWorkbenchApp } from '@openqueue/workbench/h3';
import {
  type BullmqTransport,
  isBullmqTransport,
  worldBullmq,
} from '@openqueue/world-bullmq';
import type { H3 } from 'h3';
import { createHealthServer } from './health';
import { createQueueMetrics } from './metrics';

/**
 * Maps a config loaded via {@link loadConfig} back to the directory it was read
 * from, so `dirs`/`tasks` discovery resolves relative to the config file rather
 * than `process.cwd()`.
 */
export const configDirs = new WeakMap<OpenQueueConfig, string>();

export interface CreateWorkerAppOptions {
  cwd?: string;
  tasks?: QueueTaskDiscovery | TaskDefinition[];
}

export interface WorkerAppHandle {
  runtime: QueueWorkerRuntime;
  /** Fully mounted h3 app: /health, /ready, /metrics, /openqueue/v1, workbench. */
  app: H3;
  /** Idempotent: ready=false, then runtime.close() (drain consumers → close world). */
  close(): Promise<void>;
}

/**
 * Assemble the worker's h3 app: boot the runtime + consumers, then mount the
 * control API, health/ready/metrics, and (optionally) the workbench. Returns a
 * listener-free handle; a host ({@link startWorkerApp} or the Nitro plugin)
 * owns the socket and signal wiring.
 */
export async function createWorkerApp(
  config: OpenQueueConfig,
  options: CreateWorkerAppOptions = {},
): Promise<WorkerAppHandle> {
  const world = validateConfig(config);
  const cwd = options.cwd ?? configDirs.get(config) ?? process.cwd();
  const tasks = options.tasks ?? (await resolveTasks(config, cwd));
  const drains = [consoleDrain(), ...(config.drains ?? [])];
  const runtime = await createQueueWorker({
    namespace: config.namespace,
    world,
    tasks,
    drains,
    globalConcurrency: config.concurrency?.global,
    queueConcurrency: config.concurrency?.queues,
  });
  const queues = bullmqQueues(runtime);
  const queueNames = queues.map((queue) => queue.name).sort();
  const state = { ready: true };
  const health = createHealthServer(state, {
    metrics:
      config.metrics?.enabled === false
        ? undefined
        : createQueueMetrics(queues, config.metrics?.prefix),
  });

  const controlAuth = resolveControlAuth(
    config.api && { token: config.api.token, strategies: config.api.auth },
    { nodeEnv: process.env.NODE_ENV },
  );
  health.mount(
    '/openqueue/v1',
    buildControlApp({
      runtime: {
        trigger: runtime.trigger,
        runs: runtime.runs,
        schedules: runtime.schedules,
        catalog: {
          read: async () => runtime.catalog,
          resolve: async (id) =>
            runtime.catalog.find((entry) => entry.id === id),
        },
      },
      auth: { token: config.api?.token, strategies: config.api?.auth },
      info: { namespace: config.namespace },
    }),
  );
  console.log(
    `[openqueue] control API mounted at /openqueue/v1 (auth: ${controlAuth.mode})`,
  );

  let workbench: WorkbenchCore | undefined;
  if (config.workbench?.enabled) {
    const basePath = config.workbench.basePath ?? '/workbench';
    workbench = createWorkbenchForRuntime(runtime, config, queues);
    health.mount(basePath, buildWorkbenchApp(workbench));
    if (queues.length === 0) {
      console.log(
        '[openqueue] workbench: no BullMQ queues on this world — queue/run pages will be empty; use /openqueue/v1 for run history',
      );
    }
  }

  console.log(
    `[openqueue] started ${runtime.consumers.length} consumers across ${queueNames.length} queues with global concurrency ${config.concurrency?.global ?? 'unbounded'}`,
  );
  console.log(`[openqueue] published ${runtime.catalog.length} tasks`);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    state.ready = false;
    // The workbench started its own alert-manager interval + QueueEvents
    // listeners; the runtime doesn't own them, so tear it down here or the event
    // loop never drains.
    await workbench?.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
  };

  return { runtime, app: health, close };
}

/**
 * Validate the config and resolve its delivery backend to a {@link WorldFactory}.
 * The `redis` sugar becomes `worldBullmq({ url, prefix, storage })` — the sole
 * place the worker reaches for `@openqueue/world-bullmq`.
 */
function validateConfig(config: OpenQueueConfig): WorldFactory {
  if (!config.namespace?.trim()) {
    throw new Error('OpenQueue config requires namespace');
  }
  if (config.world && config.redis?.url) {
    throw new Error('OpenQueue config accepts either redis or world, not both');
  }
  const hasDirs = Array.isArray(config.dirs) && config.dirs.length > 0;
  const hasTasks = Boolean(config.tasks);
  if (!hasDirs && !hasTasks) {
    throw new Error('OpenQueue config requires dirs or tasks');
  }
  const basePath = config.workbench?.basePath;
  if (basePath === '/openqueue' || basePath?.startsWith('/openqueue/')) {
    throw new Error(
      'OpenQueue config workbench.basePath cannot use the reserved /openqueue prefix',
    );
  }
  if (config.world) {
    if (config.storage) {
      throw new Error(
        'OpenQueue config: the world owns durable state; configure it inside the world factory',
      );
    }
    return config.world;
  }
  if (config.redis?.url) {
    return worldBullmq({
      url: config.redis.url,
      prefix: config.redis.bullPrefix,
      storage: config.storage,
    });
  }
  throw new Error('OpenQueue config requires redis.url or world');
}

type BullmqQueue = ReturnType<BullmqTransport['queue']>;

/**
 * The BullMQ `Queue` instances the dashboard and metrics read, or `[]` on a
 * non-BullMQ world. One per task queue (the schedule-tick queue is excluded, as
 * before); `transport.queue()` caches, so repeated calls share instances.
 */
function bullmqQueues(runtime: QueueWorkerRuntime): BullmqQueue[] {
  const transport = runtime.transport;
  if (!isBullmqTransport(transport)) return [];
  const names = Array.from(
    new Set(runtime.tasks.map((task) => task.queue)),
  ).sort();
  return names.map((name) => transport.queue(name));
}

export function createWorkbenchForRuntime(
  runtime: QueueWorkerRuntime,
  config: OpenQueueConfig,
  queues: BullmqQueue[] = bullmqQueues(runtime),
): WorkbenchCore {
  const workbench = config.workbench ?? {};
  return new WorkbenchCore({
    queues,
    title: workbench.title ?? 'OpenQueue',
    prefix: config.redis?.bullPrefix ?? 'bull',
    readonly: workbench.readonly ?? false,
    auth: workbench.auth,
    tagFields: workbench.tagFields ?? [],
    // Match the mount default (startWorkerApp mounts the app at `/workbench`
    // when basePath is unset). h3 `.mount()` strips the prefix before the app
    // computes the HTML `<base href>`, so without this the dashboard would emit
    // base `/` and request `/assets`/`/api` at the server root.
    basePath: workbench.basePath ?? '/workbench',
    queue: {
      schedules: runtime.schedules,
      spans: runtime.spans,
    },
    alerts: {
      persistence: config.storage
        ? 'postgres'
        : config.world
          ? 'custom'
          : 'redis',
      store: runtime.alerts,
      delivery: true,
    },
    registry: {
      jobs: runtime.catalog.map(catalogJob),
      flows: [],
      enqueueJob: (job, input, opts) => runtime.trigger(job.name, input, opts),
      enqueueFlow: async () => {
        throw new Error('Flow catalog entries are not published yet');
      },
    },
  });
}

async function resolveTasks(
  config: OpenQueueConfig,
  cwd: string,
): Promise<TaskDefinition[]> {
  if (config.tasks) {
    const loaded = await Promise.all(
      taskModules(config.tasks).map((source) => loadTaskModule(source, cwd)),
    );
    return validateTaskDefinitions(loaded.flat());
  }

  for (const dir of config.dirs ?? []) {
    // Side effect only: import the dir's task files, registering anything new.
    await loadQueueTasks(
      defineQueueTasks({
        cwd: resolve(cwd, dir),
        include: [
          '**/*.ts',
          '**/*.tsx',
          '**/*.mts',
          '**/*.cts',
          '**/*.js',
          '**/*.jsx',
          '**/*.mjs',
          '**/*.cjs',
        ],
        exclude: config.exclude,
      }),
    );
  }
  // Read the full registry, not loadQueueTasks' newly-registered delta: a config
  // that statically imports its task files registers them before discovery runs,
  // so the delta would be empty. validateTaskDefinitions dedups/validates by id.
  return validateTaskDefinitions(getRegisteredTasks());
}

async function loadTaskModule(
  source: QueueConfigTaskModule,
  cwd: string,
): Promise<TaskDefinition[]> {
  const mod = (await import(
    pathToFileURL(resolve(cwd, source.module)).href
  )) as Record<string, unknown>;
  const value = exportedValue(mod, source);
  return loadQueueTasks(value as QueueTaskDiscovery | TaskDefinition[]);
}

function taskModules(
  source: QueueConfigTaskModule | QueueConfigTaskModule[],
): QueueConfigTaskModule[] {
  return Array.isArray(source) ? source : [source];
}

function exportedValue(
  mod: Record<string, unknown>,
  source: QueueConfigTaskModule,
): unknown {
  if (source.export) {
    const value = mod[source.export];
    if (!value) {
      throw new Error(
        `OpenQueue task module "${source.module}" does not export "${source.export}"`,
      );
    }
    return value;
  }

  const value = mod.default ?? mod.tasks;
  if (!value) {
    throw new Error(
      `OpenQueue task module "${source.module}" must export default or tasks`,
    );
  }
  return value;
}

function catalogJob(entry: QueueCatalogEntry): WorkbenchJobDefinition {
  return {
    name: entry.name,
    queue: entry.queue,
    description: entry.description,
    handler: null,
    concurrency: entry.concurrency,
    attempts: entry.attempts,
    backoff: entry.backoff,
    cron: entry.cron,
    maxStalledCount: entry.maxStalledCount,
    tags: entry.tags,
  };
}
