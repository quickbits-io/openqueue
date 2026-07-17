import { queueCatalogEntries } from './catalog';
import { composeWorldRuntime } from './control-compose';
import { loadQueueTasks, type QueueTaskDiscovery } from './discovery';
import { configureEnqueueTransport } from './enqueue';
import { type NamespaceOptions, resolveNamespace } from './namespace';
import { type QueueScheduleController, scheduleTickJob } from './schedules';
import { attachSpanStore } from './span-export';
import { bindQueueRuntime } from './task';
import type { QueueTransport, TransportConsumer } from './transport/types';
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
  TaskDefinition,
} from './types';
import { createWorkerConsumers, type QueueConcurrency } from './worker';
import { type OpenQueueWorld, validateWorld, type WorldFactory } from './world';

export interface QueueClientOptions extends NamespaceOptions {
  world: WorldFactory;
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
  world: WorldFactory;
  tasks: QueueTaskDiscovery | TaskDefinition[];
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
  /** The world's delivery bus. Narrow with a transport-specific guard (e.g.
   *  `isBullmqTransport` from `@openqueue/world-bullmq`) for escape hatches. */
  transport: QueueTransport;
  /** One consumer per queue plus the schedule-tick queue. */
  consumers: readonly TransportConsumer[];
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

export async function createQueueClient(
  options: QueueClientOptions,
): Promise<QueueClient> {
  const namespace = resolveNamespace(options);
  const world = validateWorld(
    await options.world({ namespace: namespace.namespace }),
  );
  return createQueueClientFromWorld(world, {
    drains: options.drains,
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
  const tasks = await loadQueueTasks(options.tasks);
  const world = validateWorld(
    await options.world({ namespace: namespace.namespace }),
  );
  return createQueueWorkerFromWorld(world, {
    drains: options.drains,
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

  const consumers = createWorkerConsumers(workerTasks, transport, {
    drain: parts.drain,
    globalConcurrency: options.globalConcurrency,
    queueConcurrency: options.queueConcurrency,
  });

  const runtime: QueueWorkerRuntime = {
    tasks,
    catalog,
    transport,
    consumers,
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
