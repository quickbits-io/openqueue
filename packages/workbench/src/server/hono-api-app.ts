import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { cors } from 'hono/cors';
import { createApiRoutes } from '../api/router';
import type { WorkbenchCore } from '../core/workbench';

/**
 * Build an API-only Hono app for Workbench: `/api/*` and `/config`, with CORS
 * on `/api/*` and optional basic-auth. Does **not** serve `index.html`,
 * `/assets/:file`, or any static UI.
 *
 * Used by the Tauri desktop sidecar, which hosts the dashboard UI from the
 * Tauri webview directly and only needs the JSON API on a loopback port.
 *
 * Adapter consumers (`@openqueue/workbench/hono`, `@openqueue/workbench/elysia`, etc.)
 * continue to use {@link buildWorkbenchApp} which also serves the bundled UI.
 */
export function buildWorkbenchApiApp(core: WorkbenchCore): Hono {
  const app = new Hono();

  app.use('/api/*', cors());
  app.use('/config', cors());

  if (core.requiresAuth()) {
    app.use(
      '*',
      basicAuth({
        username: core.options.auth!.username,
        password: core.options.auth!.password,
      }),
    );
  }

  app.route('/api', createApiRoutes(core));

  app.get('/config', (c) => c.json(core.getConfig()));

  return app;
}

export function buildWorkbenchApiRouter(core: WorkbenchCore): Hono {
  const app = new Hono();

  if (core.requiresAuth()) {
    app.use(
      '*',
      basicAuth({
        username: core.options.auth!.username,
        password: core.options.auth!.password,
      }),
    );
  }

  app.route('/', createApiRoutes(core));
  app.get('/config', (c) => c.json(core.getConfig()));

  return app;
}
