import { Redis, type Redis as RedisClient } from 'ioredis';
import { queueCatalogEntries } from './catalog';
import {
  closeConnection,
  createConnection,
  type QueueConnection,
} from './connection';
import { composeWorldRuntime } from './control-compose';
import { loadQueueTasks, type QueueTaskDiscovery } from './discovery';
import { configureEnqueueTransport } from './enqueue';
import { type NamespaceOptions, resolveNamespace } from './namespace';
import type { createQueue } from './queue';
import { type QueueScheduleController, scheduleTickJob } from './schedules';
import { attachSpanStore } from './span-export';
import { bindQueueRuntime } from './task';
import { isBullmqTransport } from './transport/bullmq';
import type { TransportConsumer } from './transport/types';
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
import {
  type createWorker,
  createWorkerConsumers,
  type QueueConcurrency,
} from './worker';
import { type OpenQueueWorld, validateWorld, type WorldFactory } from './world';
import { worldBullmq } from './world-bullmq';

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

export interface CreateQueueWorkerRedisOptions extends NamespaceOptions {
  redis: { url: string } | QueueConnection;
  tasks: QueueTaskDiscovery | TaskDefinition[];
  catalog?: QueueCatalogStore | QueueCatalogStore[];
  storage?: QueueStorage;
  drains?: QueueDrain[];
  globalConcurrency?: number;
  queueConcurrency?: QueueConcurrency;
  world?: undefined;
}

/**
 * World-backed worker options. The world owns its transport and durable store,
 * so `redis`, `catalog`, and `storage` are deliberately absent — configure them
 * inside the world factory instead.
 */
export interface CreateQueueWorkerWorldOptions extends NamespaceOptions {
  world: WorldFactory;
  tasks: QueueTaskDiscovery | TaskDefinition[];
  drains?: QueueDrain[];
  globalConcurrency?: number;
  queueConcurrency?: QueueConcurrency;
  redis?: undefined;
}

export type CreateQueueWorkerOptions =
  | CreateQueueWorkerRedisOptions
  | CreateQueueWorkerWorldOptions;

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

/** Shared wiring options for the world-composed runtime factories. */
export interface FromWorldOptions extends NamespaceOptions {
  drains?: Array<QueueDrain | false | null | undefined>;
  /** Ownership cleanup (e.g. a caller-owned Redis connection) run last. */
  onClose?: () => Promise<void>;
}

export interface WorkerFromWorldOptions extends FromWorldOptions {
  tasks: TaskDefinition[];
  globalConcurrency?: number;
  queueConcurrency?: QueueConcurrency;
}

export function createQueueClient(options: QueueClientOptions): QueueClient {
  const namespace = resolveNamespace(options);
  const { redis, close } = resolveClientRedis(options.redis);
  const world = validateWorld(
    worldBullmq({
      producer: redis,
      storage: options.storage,
      catalogFallbacks: normalizeStores(options.catalog, options.storage),
    })({ namespace }),
  );
  return createQueueClientFromWorld(world, {
    drains: [options.storage, ...(options.drains ?? [])],
    onClose: close,
    ...namespace,
  });
}

export function createQueueClientFromWorld(
  world: OpenQueueWorld,
  options: FromWorldOptions = {},
): QueueClient {
  const parts = composeWorldRuntime(world, options);
  configureEnqueueTransport({ transport: world.transport, drain: parts.drain });

  const client: QueueClient = {
    catalog: parts.catalog,
    trigger: parts.trigger,
    schedules: parts.schedules,
    runs: parts.runs,
    spans: world.store.spans,
    alerts: world.store.alerts,
    close: async () => {
      await parts.close();
      await options.onClose?.();
    },
  };

  bindQueueRuntime(client);
  return client;
}

export async function createQueueWorker(
  options: CreateQueueWorkerOptions,
): Promise<QueueWorkerRuntime> {
  const namespace = resolveNamespace(options);

  if (options.world) {
    const tasks = await loadQueueTasks(options.tasks);
    const world = validateWorld(await options.world({ namespace }));
    return createQueueWorkerFromWorld(world, {
      drains: options.drains,
      tasks,
      globalConcurrency: options.globalConcurrency,
      queueConcurrency: options.queueConcurrency,
      ...namespace,
    });
  }

  const { connection, ownsConnection } = resolveWorkerConnection(options.redis);
  const tasks = await loadQueueTasks(options.tasks);
  const world = validateWorld(
    worldBullmq({
      producer: connection.producer,
      consumer: connection.worker,
      storage: options.storage,
      catalogFallbacks: normalizeStores(options.catalog, options.storage),
    })({ namespace }),
  );
  return createQueueWorkerFromWorld(world, {
    drains: [options.storage, ...(options.drains ?? [])],
    onClose: ownsConnection ? () => closeConnection(connection) : undefined,
    tasks,
    globalConcurrency: options.globalConcurrency,
    queueConcurrency: options.queueConcurrency,
    ...namespace,
  });
}

export async function createQueueWorkerFromWorld(
  world: OpenQueueWorld,
  options: WorkerFromWorldOptions,
): Promise<QueueWorkerRuntime> {
  const namespace = resolveNamespace(options);
  const { store, transport } = world;
  await world.start?.();

  const parts = composeWorldRuntime(world, options);
  configureEnqueueTransport({ transport, drain: parts.drain });

  const tasks = options.tasks;
  const catalog = queueCatalogEntries(tasks);
  await store.publish(catalog);

  const { trigger, schedules, runs } = parts;
  bindQueueRuntime({ trigger, schedules });
  await syncDeclarativeSchedules(tasks, schedules);

  const workerTasks = [
    ...tasks,
    scheduleTickJob(schedules, namespace),
  ] as TaskDefinition[];

  if (store.spans) attachSpanStore(store.spans);

  const consumerOptions = {
    drain: parts.drain,
    globalConcurrency: options.globalConcurrency,
    queueConcurrency: options.queueConcurrency,
  };

  let consumers: TransportConsumer[];
  let workers: ReturnType<typeof createWorker> = [];
  let queues: Map<string, ReturnType<typeof createQueue>> = new Map();
  if (isBullmqTransport(transport)) {
    const bullmqConsumers = createWorkerConsumers(
      workerTasks,
      transport,
      consumerOptions,
    );
    consumers = bullmqConsumers;
    workers = bullmqConsumers.map((consumer) => consumer.worker);
    const queueNames = Array.from(
      new Set(tasks.map((task) => task.queue)),
    ).sort();
    queues = new Map(queueNames.map((name) => [name, transport.queue(name)]));
  } else {
    consumers = createWorkerConsumers(workerTasks, transport, consumerOptions);
  }

  const runtime: QueueWorkerRuntime = {
    tasks,
    catalog,
    workers,
    queues,
    trigger,
    schedules,
    runs,
    spans: store.spans,
    alerts: store.alerts,
    close: async () => {
      await Promise.all(consumers.map((consumer) => consumer.close()));
      await parts.close();
      await options.onClose?.();
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
