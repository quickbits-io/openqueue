import { Hono } from 'hono';
import { basicAuth } from 'hono/basic-auth';
import { cors } from 'hono/cors';
import { createApiRoutes } from '../api/router';
import type { WorkbenchCore } from '../core/workbench';
import { resolveBasePath } from './base-path';
import {
  renderIndexHtml,
  serveStaticAsset,
  serveUiFile,
} from './static-assets';

/**
 * Build a fully-wired Hono app for Workbench:
 *
 * - `POST /api/*`, `GET /api/*` etc.   — JSON API
 * - `GET /config`                       — UI bootstrap config
 * - `GET /assets/:file`                 — static asset reader
 * - `GET *`                             — `index.html` with `<base href>`
 * - CORS on `/api/*`
 * - Basic auth on everything when `core.requiresAuth()` is true
 *
 * Used directly by `@openqueue/workbench/hono` (returned as-is for `.route()`
 * mounting) and indirectly by `createFetchHandler` for non-Hono adapters.
 */
export function buildWorkbenchApp(core: WorkbenchCore): Hono {
  const app = new Hono();

  app.use('/api/*', cors());

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

  app.get('/assets/:file', (c) => {
    const fileName = c.req.param('file');
    const asset = serveStaticAsset(fileName);
    if (asset.status === 404 || !asset.body) {
      return c.text('Not found', 404);
    }
    return new Response(new Uint8Array(asset.body), {
      status: 200,
      headers: { 'Content-Type': asset.contentType },
    });
  });

  app.get('/app-icon.svg', (c) => {
    const asset = serveUiFile('app-icon.svg');
    if (asset.status === 404 || !asset.body) {
      return c.text('Not found', 404);
    }
    return new Response(new Uint8Array(asset.body), {
      status: 200,
      headers: { 'Content-Type': asset.contentType },
    });
  });

  app.get('*', (c) => {
    const url = new URL(c.req.url);
    const basePath = resolveBasePath(core.options.basePath, url.pathname);
    const html = renderIndexHtml(basePath, core.options.title || 'Workbench');
    return c.html(html.body);
  });

  return app;
}
