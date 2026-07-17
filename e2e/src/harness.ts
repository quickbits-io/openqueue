import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createClient,
  type OpenQueueClient,
  OpenQueueClientError,
} from '@openqueue/client';
import {
  defineConfig,
  getRegisteredTasks,
  postgresAdapter,
  type QueueConfig,
} from '@openqueue/sdk';
import { startWorkerApp } from '@openqueue/worker';
import { worldPostgres } from '@openqueue/world-postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { DATABASE_URL, REDIS_URL, WORLD } from './env';
import { queueSchema } from './queue-schema';
// Side-effect import: `task()` in echo.ts registers the task into the
// process-global registry at module load, which `getRegisteredTasks()` reads.
import './worker/echo';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

export interface TestWorker {
  url: string;
  namespace: string;
  token: string | undefined;
  client: OpenQueueClient;
  db: ReturnType<typeof drizzle>;
  close(): Promise<void>;
}

export async function startTestWorker(
  options: {
    token?: string | false;
    /** Full `api` config; wins over the `token` shorthand when set. */
    api?: QueueConfig['api'];
    workbench?: QueueConfig['workbench'];
    /** Fixed namespace — used by the split-plane suite to share one with the control plane. */
    namespace?: string;
  } = {},
): Promise<TestWorker> {
  const namespace = options.namespace ?? `e2e-${randomUUID()}`;
  const token =
    options.token === false
      ? undefined
      : (options.token ??
        (options.api === undefined ? `tok-${randomUUID()}` : undefined));
  const api = options.api ?? (token === undefined ? undefined : { token });
  const sql = postgres(DATABASE_URL);
  const db = drizzle(sql);
  // The postgres world owns its own client + durable store (no `storage`); the
  // BullMQ path pairs Redis delivery with the postgresAdapter store. `db` above
  // is the test's own read handle into the same schema in both modes.
  const config =
    WORLD === 'postgres'
      ? defineConfig({
          namespace,
          dirs: ['./src/worker'],
          world: worldPostgres({ url: DATABASE_URL, migrations: 'auto' }),
          api,
          workbench: options.workbench,
        })
      : defineConfig({
          namespace,
          dirs: ['./src/worker'],
          redis: { url: REDIS_URL },
          storage: { adapter: postgresAdapter({ db, schema: queueSchema }) },
          api,
          workbench: options.workbench,
        });
  const app = await startWorkerApp(
    config,
    // Tasks are passed explicitly rather than via `dirs` discovery. Discovery
    // (`loadQueueTasks`) returns only the tasks that a run's cached module
    // imports newly appended to the global registry; under `bun test` every
    // file shares one module graph, so on the 2nd+ worker boot the cached
    // re-import re-runs no `task()` side effect and discovery yields zero
    // tasks. `getRegisteredTasks()` returns the already-registered
    // `TaskDefinition[]` and boots the identical `createQueueWorker` path
    // reliably. `dirs` stays on the config to satisfy validation.
    { cwd: packageRoot, port: 0, signals: false, tasks: getRegisteredTasks() },
  );
  const url = `http://localhost:${app.port}`;
  const client = createClient(
    token === undefined
      ? { host: url }
      : { host: url, auth: { bearer: token } },
  );
  return {
    url,
    namespace,
    token,
    client,
    db,
    close: async () => {
      // BullMQ's blocking connections reject with "Connection is closed" when a
      // worker is torn down mid-block. `bun test` fails a run on any unhandled
      // rejection and records them below the process/event handler layer, so
      // the only fix is to prevent them: attach a no-op error handler to each
      // worker's Redis clients before closing. `blockingConnection` is private
      // on BullMQ's Worker, reached via typed element access (no cast).
      await Promise.all(
        app.runtime.workers.flatMap((worker) =>
          // biome-ignore lint/complexity/useLiteralKeys: private BullMQ fields; dot access fails typecheck
          [worker['blockingConnection'], worker['connection']].map(
            async (connection) => {
              try {
                const client = await connection.client;
                client.on('error', () => {});
              } catch {
                // Connection already gone — nothing to silence.
              }
            },
          ),
        ),
      );
      await app.close();
      await sql.end();
    },
  };
}

/** Boot with NODE_ENV=production and no token — the locked-mode worker.
 *  buildControlApp samples NODE_ENV at construction, so restoring it
 *  immediately after boot is safe. If Phase 2 moves auth to per-request env
 *  reads, switch this to a spawned child process. */
export async function startLockedWorker(): Promise<TestWorker> {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    return await startTestWorker({ token: false });
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
}

/**
 * Await a request expected to reject and return its {@link OpenQueueClientError}
 * so a test can assert on the typed `code`. Rethrows any other rejection and
 * fails loudly if the request unexpectedly resolves.
 */
export async function clientErrorFrom(
  promise: Promise<unknown>,
): Promise<OpenQueueClientError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpenQueueClientError) return error;
    throw error;
  }
  throw new Error('expected the request to reject with OpenQueueClientError');
}
