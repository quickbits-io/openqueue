import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  OpenQueueConfig,
  QueueTaskDiscovery,
  QueueWorkerRuntime,
  TaskDefinition,
} from '@openqueue/core';
import { serve } from 'h3';
import { configDirs, createWorkerApp } from './app';

export { createWorkbenchForRuntime } from './app';

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
  const handle = await createWorkerApp(config, options);
  const port = options.port ?? Number(process.env.PORT ?? 8090);
  // srvx defaults `gracefulShutdown` on, which would install its own SIGTERM
  // handling and double-drive shutdown; we own signals below, so keep it off.
  const server = serve(handle.app, {
    port,
    silent: true,
    gracefulShutdown: false,
    bun: { idleTimeout: 30 },
  });
  await server.ready();
  const bound = Number(
    new URL(server.url ?? `http://localhost:${port}`).port || port,
  );

  console.log(`[openqueue] health server listening on :${bound}`);

  let closed = false;
  const drain = async () => {
    console.log('[openqueue] shutdown received, draining');
    await close();
    process.exit(0);
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    process.off('SIGTERM', drain);
    process.off('SIGINT', drain);
    await handle.close();
    await server.close(true);
  };

  if (options.signals !== false) {
    process.once('SIGTERM', drain);
    process.once('SIGINT', drain);
  }

  return { runtime: handle.runtime, port: bound, close };
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
