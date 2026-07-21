import type { OpenQueueConfig, TaskDefinition } from '@openqueue/core';
import { createWorkerApp, type WorkerAppHandle } from './app';

/**
 * The slice of Nitro's app we touch: the `close` lifecycle hook. Typed
 * structurally so `@openqueue/worker` carries no `nitro` dependency.
 */
interface NitroAppLike {
  hooks: { hook(name: 'close', handler: () => Promise<void>): unknown };
}

export interface NitroWorkerOptions {
  config: OpenQueueConfig;
  tasks: TaskDefinition[];
}

let handle: WorkerAppHandle | undefined;
let initialized = false;
let closed = false;

/**
 * Build the Nitro boot plugin. It connects the world, starts consumers, and
 * mounts the worker's h3 app — blocking Nitro init, so the port opens only once
 * the worker is ready. Drain is wired to Nitro's `close` hook and to
 * SIGTERM/SIGINT, since the node-server preset installs no signal handling.
 */
export function createNitroWorkerPlugin(
  options: NitroWorkerOptions,
): (nitroApp: NitroAppLike) => Promise<void> {
  return async (nitroApp) => {
    if (initialized) {
      throw new Error(
        'createNitroWorkerPlugin: one worker plugin per process; the artifact generates exactly one',
      );
    }
    initialized = true;
    handle = await createWorkerApp(
      { ...options.config },
      { tasks: options.tasks },
    );
    nitroApp.hooks.hook('close', drain);
    process.once('SIGTERM', () => {
      void drain().finally(() => process.exit(143));
    });
    process.once('SIGINT', () => {
      void drain().finally(() => process.exit(130));
    });
  };
}

/**
 * Delegate a request to the mounted worker app. Returns `503 worker booting`
 * during the window where Nitro accepts connections before the boot plugin has
 * finished — the externally-ordered case `openqueue start`'s health poll and
 * platform readiness probes wait out.
 */
export async function nitroWorkerFetch(request: Request): Promise<Response> {
  if (!handle) return new Response('worker booting', { status: 503 });
  return handle.app.fetch(request);
}

/** Idempotent: ready=false, then drain in-flight and close the world. Never exits. */
async function drain(): Promise<void> {
  if (closed) return;
  closed = true;
  await handle?.close();
}
