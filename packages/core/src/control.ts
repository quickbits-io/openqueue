import { composeWorldRuntime } from './control-compose';
import { type NamespaceOptions, resolveNamespace } from './namespace';
import type {
  EnqueueOptions,
  EnqueueResult,
  QueueCatalogStore,
  QueueDrain,
  QueueRunsApi,
  QueueSchedulesApi,
  TaskDefinition,
} from './types';
import { type OpenQueueWorld, validateWorld, type WorldFactory } from './world';

export interface ControlRuntimeOptions extends NamespaceOptions {
  /** Extra drains composed after the world's own store. */
  drains?: QueueDrain[];
}

/**
 * A producer-side control-plane runtime: `trigger`, `runs`, `schedules`, and
 * `catalog` over a world that runs **no consumers, mutates no module-global
 * state, and applies no DDL**. It is the enqueue/observe half of a two-plane
 * deployment — an edge/serverless surface that hands work to a separate
 * execution worker.
 *
 * Lifecycle seam: producer-side compositions never start a world. Only
 * `createQueueWorkerFromWorld` calls `world.start?.()` (which applies
 * migrations). `createControlRuntime` instead **validates**: a world exposing
 * `migrations` is probed and any pending/checksum-mismatched step throws an
 * actionable error — even for `migrations: 'auto'` factories — so a shared world
 * factory imported into both configs can never leak DDL into a cold start.
 *
 * `spans`/`alerts` are execution-plane concerns and are deliberately absent.
 *
 * Shares the `ControlRuntime` name with `@openqueue/workbench` (whose interface
 * omits `close`); this one adds `close` and is structurally assignable to it, so
 * it drops straight into `buildControlApp`.
 */
export interface ControlRuntime {
  trigger<I, O = unknown>(
    id: string | TaskDefinition<I, O>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
  runs: QueueRunsApi;
  schedules: QueueSchedulesApi;
  catalog: Pick<QueueCatalogStore, 'read' | 'resolve'>;
  close(): Promise<void>;
}

/**
 * Compose a {@link ControlRuntime} from a world factory. Async because it probes
 * migration status before composing (the never-migrate gate above); it never
 * calls `world.start()`.
 */
export async function createControlRuntime(
  world: WorldFactory,
  options: ControlRuntimeOptions = {},
): Promise<ControlRuntime> {
  const namespace = resolveNamespace(options);
  const resolved = validateWorld(await world({ namespace }));
  try {
    await assertMigrationsApplied(resolved);
  } catch (error) {
    // The gate opened the world (e.g. a Postgres connection); release it before
    // surfacing the fatal boot error so a caller that recovers doesn't leak it.
    await resolved.close().catch(() => undefined);
    throw error;
  }

  const parts = composeWorldRuntime(resolved, {
    drains: options.drains,
    ...namespace,
  });

  return {
    trigger: parts.trigger,
    runs: parts.runs,
    schedules: parts.schedules,
    catalog: parts.catalog,
    close: parts.close,
  };
}

async function assertMigrationsApplied(world: OpenQueueWorld): Promise<void> {
  if (!world.migrations) return;
  const status = await world.migrations.status();
  const pending = status.filter((step) => step.state !== 'applied');
  if (pending.length === 0) return;
  const ids = pending.map((step) => step.id).join(', ');
  throw new Error(
    `@openqueue/core: ${pending.length} pending migration(s) (${ids}). ` +
      "The control plane never applies DDL — boot the execution worker with migrations: 'auto', " +
      'or apply them with `openqueue migrations print`.',
  );
}
