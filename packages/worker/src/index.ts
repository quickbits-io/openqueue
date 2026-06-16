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
} from '@openqueue/core';
import {
  WorkbenchCore,
  type WorkbenchJobDefinition,
} from '@openqueue/workbench';
import { buildWorkbenchApp } from '@openqueue/workbench/hono';
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
  close(): Promise<void>;
}

export async function startWorkerApp(
  config: OpenQueueConfig,
  options: StartWorkerAppOptions = {},
): Promise<WorkerApp> {
  validateConfig(config);
  const cwd = options.cwd ?? configDirs.get(config) ?? process.cwd();
  const tasks = options.tasks ?? (await resolveTasks(config, cwd));
  const drains = [consoleDrain(), ...(config.drains ?? [])];
  const runtime = await createQueueWorker({
    namespace: config.namespace,
    bullPrefix: config.redis.bullPrefix,
    redis: { url: config.redis.url },
    tasks,
    storage: config.storage?.adapter,
    drains,
    globalConcurrency: config.concurrency?.global,
    queueConcurrency: config.concurrency?.queues,
  });
  const queueNames = Array.from(runtime.queues.keys()).sort();
  const state = { ready: true };
  const health = createHealthServer(state, {
    metrics:
      config.metrics?.enabled === false
        ? undefined
        : createQueueMetrics(
            Array.from(runtime.queues.values()),
            config.metrics?.prefix,
          ),
  });

  if (config.workbench?.enabled) {
    const basePath = config.workbench.basePath ?? '/workbench';
    health.route(
      basePath,
      buildWorkbenchApp(createWorkbenchForRuntime(runtime, config)),
    );
  }

  const port = options.port ?? Number(process.env.PORT ?? 8090);
  const server = Bun.serve({
    port,
    fetch: health.fetch,
    idleTimeout: 30,
  });

  console.log(
    `[openqueue] started ${runtime.workers.length} workers across ${queueNames.length} queues with global concurrency ${config.concurrency?.global ?? 'unbounded'}`,
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

  return { runtime, close };
}

function validateConfig(config: OpenQueueConfig): void {
  if (!config.namespace?.trim()) {
    throw new Error('OpenQueue config requires namespace');
  }
  if (!config.redis?.url) {
    throw new Error('OpenQueue config requires redis.url');
  }
  const hasDirs = Array.isArray(config.dirs) && config.dirs.length > 0;
  const hasTasks = Boolean(config.tasks);
  if (!hasDirs && !hasTasks) {
    throw new Error('OpenQueue config requires dirs or tasks');
  }
}

export function createWorkbenchForRuntime(
  runtime: QueueWorkerRuntime,
  config: OpenQueueConfig,
): WorkbenchCore {
  const workbench = config.workbench ?? {};
  return new WorkbenchCore({
    queues: Array.from(runtime.queues.values()),
    title: workbench.title ?? 'OpenQueue',
    prefix: config.redis.bullPrefix ?? 'bull',
    readonly: workbench.readonly ?? false,
    auth: workbench.auth,
    tagFields: workbench.tagFields ?? [],
    basePath: workbench.basePath,
    queue: {
      schedules: runtime.schedules,
      spans: runtime.spans,
    },
    alerts: {
      persistence: config.storage?.adapter ? 'postgres' : 'redis',
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
    ttl: entry.ttl,
    maxStalledCount: entry.maxStalledCount,
    tags: entry.tags,
  };
}
