import { Redis, type Redis as RedisClient } from 'ioredis';
import {
  catalogEntryDefinition,
  publishQueueCatalog,
  readQueueCatalog,
  resolveQueueCatalogTask,
} from './catalog';
import { composeDrains } from './compose';
import {
  closeConnection,
  createConnection,
  type QueueConnection,
} from './connection';
import { loadQueueTasks, type QueueTaskDiscovery } from './discovery';
import { configureEnqueue, enqueue } from './enqueue';
import { type NamespaceOptions, resolveNamespace } from './namespace';
import { createQueue } from './queue';
import { createRunsApi } from './runs';
import {
  createQueueSchedules,
  type QueueScheduleController,
  scheduleTickJob,
} from './schedules';
import { attachSpanStore } from './span-export';
import { createRedisQueueState } from './state';
import { bindQueueRuntime } from './task';
import type {
  AlertStore,
  EnqueueOptions,
  EnqueueResult,
  QueueCatalogEntry,
  QueueCatalogStore,
  QueueDrain,
  QueueRunsApi,
  QueueSchedulesApi,
  QueueSpanStore,
  QueueStorage,
  TaskDefinition,
} from './types';
import { createWorker, type QueueConcurrency } from './worker';

export interface QueueClientOptions extends NamespaceOptions {
  redis: RedisClient | { url: string };
  catalog?: QueueCatalogStore | QueueCatalogStore[];
  storage?: QueueStorage;
  drains?: QueueDrain[];
}

export interface QueueClient {
  catalog: Pick<QueueCatalogStore, 'read' | 'resolve'>;
  trigger<I, O = unknown>(
    id: string | TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  schedules: QueueSchedulesApi;
  runs: QueueRunsApi;
  spans?: QueueSpanStore;
  alerts: AlertStore;
  close(): Promise<void>;
}

export interface CreateQueueWorkerOptions extends NamespaceOptions {
  redis: { url: string } | QueueConnection;
  tasks: QueueTaskDiscovery | TaskDefinition[];
  catalog?: QueueCatalogStore | QueueCatalogStore[];
  storage?: QueueStorage;
  drains?: QueueDrain[];
  globalConcurrency?: number;
  queueConcurrency?: QueueConcurrency;
}

export interface QueueWorkerRuntime {
  trigger<I, O = unknown>(
    id: string | TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  schedules: QueueSchedulesApi;
  runs: QueueRunsApi;
  spans?: QueueSpanStore;
  alerts: AlertStore;
  close(): Promise<void>;
  tasks: TaskDefinition[];
  catalog: QueueCatalogEntry[];
  workers: ReturnType<typeof createWorker>;
  queues: Map<string, ReturnType<typeof createQueue>>;
}

export function createQueueClient(options: QueueClientOptions): QueueClient {
  const namespace = resolveNamespace(options);
  const { redis, close } = resolveClientRedis(options.redis);
  const state = createRedisQueueState(redis, options.storage, namespace);
  const stores = normalizeStores(options.catalog, options.storage);
  const drain = composeDrains(
    state,
    options.storage,
    ...(options.drains ?? []),
  );
  configureEnqueue({ redis, drain, ...namespace });

  const trigger = async <I, O = unknown>(
    target: string | TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ) => {
    if (typeof target !== 'string') return enqueue(target, input, opts);
    const entry = await resolveTask(redis, stores, target, namespace.namespace);
    return enqueue(catalogEntryDefinition(entry), input, opts);
  };

  const schedules = createQueueSchedules({
    redis,
    storage: state,
    resolveTask: (id) => resolveTask(redis, stores, id, namespace.namespace),
    trigger,
    ...namespace,
  });
  const runs = createRunsApi(state.runs);

  const client: QueueClient = {
    catalog: {
      read: () => readCatalog(redis, stores, namespace.namespace),
      resolve: (id) =>
        resolveTask(redis, stores, id, namespace.namespace).then(
          (entry) => entry,
        ),
    },
    trigger,
    schedules,
    runs,
    spans: options.storage?.spans,
    alerts: state.alerts,
    close: async () => {
      await closeSchedules(schedules);
      await state.alerts.close?.();
      await close();
    },
  };

  bindQueueRuntime(client);
  return client;
}

export async function createQueueWorker(
  options: CreateQueueWorkerOptions,
): Promise<QueueWorkerRuntime> {
  const namespace = resolveNamespace(options);
  const { connection, ownsConnection } = resolveWorkerConnection(options.redis);
  const state = createRedisQueueState(
    connection.producer,
    options.storage,
    namespace,
  );
  const stores = normalizeStores(options.catalog, options.storage);
  const tasks = await loadQueueTasks(options.tasks);
  const drain = composeDrains(
    state,
    options.storage,
    ...(options.drains ?? []),
  );

  configureEnqueue({ redis: connection.producer, drain, ...namespace });

  const queueNames = Array.from(
    new Set(tasks.map((task) => task.queue)),
  ).sort();
  const queues = new Map(
    queueNames.map((name) => [
      name,
      createQueue(name, connection.producer, namespace),
    ]),
  );

  const catalog = await publishQueueCatalog(
    connection.producer,
    tasks,
    stores,
    namespace.namespace,
  );

  const trigger = async <I, O = unknown>(
    target: string | TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ) => {
    if (typeof target !== 'string') return enqueue(target, input, opts);
    const entry = await resolveTask(
      connection.producer,
      stores,
      target,
      namespace.namespace,
    );
    return enqueue(catalogEntryDefinition(entry), input, opts);
  };
  const schedules = createQueueSchedules({
    redis: connection.producer,
    storage: state,
    resolveTask: (id) =>
      resolveTask(connection.producer, stores, id, namespace.namespace),
    trigger,
    ...namespace,
  });
  const runs = createRunsApi(state.runs);
  bindQueueRuntime({ trigger, schedules });
  await syncDeclarativeSchedules(tasks, schedules as QueueScheduleController);

  const workerTasks = [
    ...tasks,
    scheduleTickJob(schedules as QueueScheduleController, namespace),
  ];

  if (options.storage?.spans) attachSpanStore(options.storage.spans);

  const workers = createWorker(workerTasks as TaskDefinition[], {
    connection: connection.worker,
    drain,
    globalConcurrency: options.globalConcurrency,
    queueConcurrency: options.queueConcurrency,
    ...namespace,
  });

  const runtime: QueueWorkerRuntime = {
    tasks,
    catalog,
    workers,
    queues,
    trigger,
    schedules,
    runs,
    spans: options.storage?.spans,
    alerts: state.alerts,
    close: async () => {
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(
        Array.from(queues.values()).map((queue) => queue.close()),
      );
      await closeSchedules(schedules);
      await state.alerts.close?.();
      if (ownsConnection) await closeConnection(connection);
    },
  };

  bindQueueRuntime(runtime);
  return runtime;
}

function normalizeStores(
  store: QueueCatalogStore | QueueCatalogStore[] | undefined,
  storage?: QueueStorage,
): QueueCatalogStore[] {
  const stores = store ? (Array.isArray(store) ? store : [store]) : [];
  if (storage) stores.push(storage);
  return stores;
}

async function resolveTask(
  redis: RedisClient,
  stores: QueueCatalogStore[],
  id: string,
  namespace: string,
): Promise<QueueCatalogEntry> {
  try {
    return await resolveQueueCatalogTask(redis, id, namespace);
  } catch (err) {
    for (const store of stores) {
      const entry = await store.resolve(id);
      if (entry) return entry;
    }

    throw err;
  }
}

async function readCatalog(
  redis: RedisClient,
  stores: QueueCatalogStore[],
  namespace: string,
): Promise<QueueCatalogEntry[]> {
  const entries = await readQueueCatalog(redis, namespace);
  if (entries.length > 0) return entries;

  for (const store of stores) {
    const stored = await store.read();
    if (stored.length > 0) return stored;
  }

  return [];
}

function resolveClientRedis(redis: RedisClient | { url: string }): {
  redis: RedisClient;
  close: () => Promise<void>;
} {
  if ('url' in redis) {
    const client = new Redis(redis.url, { lazyConnect: true });
    return {
      redis: client,
      close: async () => {
        await client.quit().catch(() => undefined);
      },
    };
  }
  return { redis, close: async () => undefined };
}

function resolveWorkerConnection(redis: { url: string } | QueueConnection): {
  connection: QueueConnection;
  ownsConnection: boolean;
} {
  if ('producer' in redis) return { connection: redis, ownsConnection: false };
  return { connection: createConnection(redis.url), ownsConnection: true };
}

async function closeSchedules(schedules: QueueSchedulesApi): Promise<void> {
  await (schedules as Partial<QueueScheduleController>).close?.();
}

async function syncDeclarativeSchedules(
  tasks: TaskDefinition[],
  schedules: QueueScheduleController,
) {
  const scheduled = tasks.filter((task) => task.cron);
  await Promise.all(scheduled.map((task) => schedules.upsertDeclarative(task)));

  const current = new Set(scheduled.map((task) => task.id));
  const existing = await schedules.list({
    meta: { scheduleType: 'declarative' },
  });
  await Promise.all(
    existing
      .filter(
        (schedule) =>
          schedule.type === 'DECLARATIVE' && !current.has(schedule.task),
      )
      .map((schedule) => schedules.delete(schedule.id)),
  );
}
