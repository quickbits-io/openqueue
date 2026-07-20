import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  consoleDrain,
  createQueueWorker,
  defineQueueTasks,
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
import { createHealthServer } from './health';
import { createQueueMetrics } from './metrics';

const configDirs = new WeakMap<OpenQueueConfig, string>();

export interface StartWorkerAppOptions {
  cwd?: string;
  port?: number;
  signals?: boolean;
  tasks?: QueueTaskDiscovery | TaskDefinition[];
}

interface WorkerApp {
  runtime: QueueWorkerRuntime;
  /** TCP port the app is listening on (useful with `port: 0`). */
  port: number;
  close(): Promise<void>;
}

export async function startWorkerApp(
  config: OpenQueueConfig,
  options: StartWorkerAppOptions = {},
): Promise<WorkerApp> {
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

  if (config.workbench?.enabled) {
    const basePath = config.workbench.basePath ?? '/workbench';
    health.mount(
      basePath,
      buildWorkbenchApp(createWorkbenchForRuntime(runtime, config, queues)),
    );
    if (queues.length === 0) {
      console.log(
        '[openqueue] workbench: no BullMQ queues on this world — queue/run pages will be empty; use /openqueue/v1 for run history',
      );
    }
  }

  const port = options.port ?? Number(process.env.PORT ?? 8090);
  const server = Bun.serve({
    port,
    fetch: (req) => health.fetch(req),
    idleTimeout: 30,
  });

  console.log(
    `[openqueue] started ${runtime.consumers.length} consumers across ${queueNames.length} queues with global concurrency ${config.concurrency?.global ?? 'unbounded'}`,
  );
  console.log(`[openqueue] published ${runtime.catalog.length} tasks`);
  console.log(`[openqueue] health server listening on :${port}`);

  let closed = false;
  const drain = async () => {
    console.log('[openqueue] shutdown received, draining');
    await close();
    process.exit(0);
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    state.ready = false;
    process.off('SIGTERM', drain);
    process.off('SIGINT', drain);
    await runtime.close().catch(() => undefined);
    server.stop(true);
  };

  if (options.signals !== false) {
    process.once('SIGTERM', drain);
    process.once('SIGINT', drain);
  }

  return { runtime, port: server.port ?? port, close };
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

export async function loadConfig(path = 'worker.config.ts') {
  const absolutePath = resolve(process.cwd(), path);
  const url = pathToFileURL(absolutePath);
  const mod = (await import(url.href)) as { default?: OpenQueueConfig };
  if (!mod.default) {
    throw new Error(`OpenQueue config "${path}" must export default config`);
  }
  configDirs.set(mod.default, dirname(absolutePath));
  return mod.default;
}

async function resolveTasks(
  config: OpenQueueConfig,
  cwd: string,
): Promise<TaskDefinition[]> {
  const manifest = resolve(
    cwd,
    config.build?.outDir ?? '.openqueue/build',
    'manifest.mjs',
  );
  if (existsSync(manifest)) {
    const mod = (await import(pathToFileURL(manifest).href)) as {
      tasks?: TaskDefinition[];
      default?: TaskDefinition[];
    };
    return validateTaskDefinitions(mod.tasks ?? mod.default ?? []);
  }

  if (config.tasks) {
    const loaded = await Promise.all(
      taskModules(config.tasks).map((source) => loadTaskModule(source, cwd)),
    );
    return validateTaskDefinitions(loaded.flat());
  }

  const loaded: TaskDefinition[] = [];
  for (const dir of config.dirs ?? []) {
    loaded.push(
      ...(await loadQueueTasks(
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
      )),
    );
  }
  return validateTaskDefinitions(loaded);
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
