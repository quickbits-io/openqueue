import { H3 } from 'h3';
import { createApiRoutes } from '../api/router';
import type { WorkbenchCore } from '../core/workbench';
import { workbenchAuthMiddleware } from './auth-middleware';
import { cors } from './cors';

function configResponse(core: WorkbenchCore): Response {
  return new Response(JSON.stringify(core.getConfig()), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build an API-only h3 app for Workbench: `/api/*` and `/config`, with CORS on
 * `/api/**` and optional basic-auth. Does **not** serve `index.html`,
 * `/assets/:file`, or any static UI.
 *
 * Used by the Tauri desktop sidecar, which hosts the dashboard UI from the
 * Tauri webview directly and only needs the JSON API on a loopback port.
 *
 * Adapter consumers (`@openqueue/workbench/h3`, `@openqueue/workbench/elysia`, etc.)
 * continue to use {@link buildWorkbenchApp} which also serves the bundled UI.
 */
export function buildWorkbenchApiApp(core: WorkbenchCore): H3 {
  const app = new H3();

  app.use('/api/**', cors);
  app.use('/config', cors);

  const authMiddleware = workbenchAuthMiddleware(core.options.auth);
  if (authMiddleware) app.use(authMiddleware);

  app.mount('/api', createApiRoutes(core));

  app.on('get', '/config', () => configResponse(core));

  return app;
}

export function buildWorkbenchApiRouter(core: WorkbenchCore): H3 {
  const app = new H3();

  const authMiddleware = workbenchAuthMiddleware(core.options.auth);
  if (authMiddleware) app.use(authMiddleware);

  app.mount('', createApiRoutes(core));
  app.on('get', '/config', () => configResponse(core));

  return app;
}
