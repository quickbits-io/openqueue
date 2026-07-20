import { createRunCancel } from './cancel';
import { catalogEntryDefinition } from './catalog';
import { composeDrains } from './compose';
import { createEnqueuer, type Enqueuer } from './enqueuer';
import { type NamespaceOptions, resolveNamespace } from './namespace';
import { UnknownTaskError } from './request-errors';
import { createRunsApi } from './runs';
import {
  createQueueSchedulesWithTransport,
  type QueueScheduleController,
} from './schedules';
import type {
  EnqueueOptions,
  EnqueueResult,
  QueueCatalogEntry,
  QueueCatalogStore,
  QueueDrain,
  QueueRunsApi,
  QueueStorage,
  TaskDefinition,
} from './types';
import type { OpenQueueWorld } from './world';

/**
 * The transport-agnostic composition shared by every world-backed runtime
 * (worker, client, control plane): a drain, an instance-scoped {@link Enqueuer},
 * a schedule controller, a runs API, and catalog read/resolve — with no
 * consumers, no module-global mutation, and no `world.start()`. The worker/client
 * factories layer their extras (consumers, spans/alerts) on top; the control
 * plane returns it near-verbatim.
 *
 * Import-clean: pulls in no ioredis/bullmq, so it rides into the
 * `@openqueue/core/control` bundle graph.
 */
export interface WorldRuntimeParts {
  drain: QueueDrain;
  enqueuer: Enqueuer;
  resolveTask(id: string): Promise<QueueCatalogEntry>;
  trigger<I, O = unknown>(
    target: string | TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  schedules: QueueScheduleController;
  runs: QueueRunsApi;
  catalog: Pick<QueueCatalogStore, 'read' | 'resolve'>;
  /** Closes the schedule controller, then the world. Excludes consumers. */
  close(): Promise<void>;
}

export interface ComposeWorldRuntimeOptions extends NamespaceOptions {
  drains?: Array<QueueDrain | false | null | undefined>;
}

export function composeWorldRuntime(
  world: OpenQueueWorld,
  options: ComposeWorldRuntimeOptions = {},
): WorldRuntimeParts {
  const namespace = resolveNamespace(options);
  const { store, transport } = world;
  const drain = composeDrains(store, ...(options.drains ?? []));
  const enqueuer = createEnqueuer({ transport, drain });

  const resolveTask = resolveTaskFromStore(store);
  const trigger = triggerFromStore(enqueuer, resolveTask);

  const schedules = createQueueSchedulesWithTransport({
    transport,
    storage: store,
    resolveTask,
    trigger,
    ...namespace,
  });
  const runs = createRunsApi(
    store.runs,
    createRunCancel({
      store: store.runs,
      transport,
      getQueue: (name) => ({ getJob: (id) => transport.getJob(name, id) }),
      drain,
    }),
  );

  return {
    drain,
    enqueuer,
    resolveTask,
    trigger,
    schedules,
    runs,
    catalog: {
      read: () => store.read(),
      // Catalog lookups report a miss as `undefined` (the `QueueCatalogStore`
      // contract) so `POST /jobs` can answer `task_not_found`; only `trigger`
      // stays strict and throws through `resolveTask` before enqueue.
      resolve: (id) => store.resolve(id),
    },
    close: async () => {
      await schedules.close();
      await world.close();
    },
  };
}

function resolveTaskFromStore(
  store: QueueStorage,
): (id: string) => Promise<QueueCatalogEntry> {
  return async (id) => {
    const entry = await store.resolve(id);
    if (!entry) throw new UnknownTaskError(id);
    return entry;
  };
}

function triggerFromStore(
  enqueuer: Enqueuer,
  resolveTask: (id: string) => Promise<QueueCatalogEntry>,
) {
  return async <I, O = unknown>(
    target: string | TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult> => {
    if (typeof target !== 'string')
      return enqueuer.enqueue(target, input, opts);
    const entry = await resolveTask(target);
    return enqueuer.enqueue(catalogEntryDefinition(entry), input, opts);
  };
}
