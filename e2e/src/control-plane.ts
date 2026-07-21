import {
  type ControlRuntime,
  createControlRuntime,
} from '@openqueue/core/control';
import { buildControlApp } from '@openqueue/workbench/control';
import { worldPostgres } from '@openqueue/world-postgres';
import { H3 } from 'h3';

export interface ControlPlane {
  url: string;
  runtime: ControlRuntime;
  close(): Promise<void>;
}

/**
 * Boot a producer-side control plane over a Postgres world with
 * `migrations: 'manual'` — it never applies DDL, so it fails fast if it comes up
 * before the execution worker has migrated the schema. `buildControlApp` (the
 * lean `@openqueue/workbench/control` entry) is mounted at `/openqueue/v1` behind
 * `Bun.serve`, with no consumers of its own.
 */
export async function startControlPlane(options: {
  url: string;
  namespace: string;
  token?: string;
}): Promise<ControlPlane> {
  const runtime = await createControlRuntime(
    worldPostgres({ url: options.url, migrations: 'manual' }),
    { namespace: options.namespace },
  );

  const app = new H3();
  app.mount(
    '/openqueue/v1',
    buildControlApp({
      runtime,
      auth: { token: options.token },
      info: { namespace: options.namespace },
    }),
  );

  const server = Bun.serve({
    port: 0,
    fetch: (req) => app.fetch(req),
    idleTimeout: 30,
  });

  return {
    url: `http://localhost:${server.port}`,
    runtime,
    close: async () => {
      server.stop(true);
      await runtime.close();
    },
  };
}
