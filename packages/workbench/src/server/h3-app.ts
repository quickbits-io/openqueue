import { H3 } from 'h3';
import { createApiRoutes } from '../api/router';
import type { WorkbenchCore } from '../core/workbench';
import { workbenchAuthMiddleware } from './auth-middleware';
import { resolveBasePath } from './base-path';
import { cors } from './cors';
import {
  renderIndexHtml,
  serveStaticAsset,
  serveUiFile,
} from './static-assets';

function notFound(): Response {
  return new Response('Not found', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
  });
}

/**
 * Build a fully-wired h3 app for Workbench:
 *
 * - `POST /api/*`, `GET /api/*` etc.   — JSON API
 * - `GET /config`                       — UI bootstrap config
 * - `GET /assets/:file`                 — static asset reader
 * - `GET /**`                           — `index.html` with `<base href>`
 * - CORS on `/api/**`
 * - Basic auth on everything when `core.options.auth` is set
 *
 * Used directly by `@openqueue/workbench/h3` (returned as-is for `.mount()`
 * mounting) and indirectly by `createFetchHandler` for non-h3 adapters.
 */
export function buildWorkbenchApp(core: WorkbenchCore): H3 {
  const app = new H3();

  app.use('/api/**', cors);

  const authMiddleware = workbenchAuthMiddleware(core.options.auth);
  if (authMiddleware) app.use(authMiddleware);

  app.mount('/api', createApiRoutes(core));

  app.on(
    'get',
    '/config',
    () =>
      new Response(JSON.stringify(core.getConfig()), {
        headers: { 'Content-Type': 'application/json' },
      }),
  );

  app.on('get', '/assets/:file', (event) => {
    const asset = serveStaticAsset(event.context.params?.file ?? '');
    if (asset.status === 404 || !asset.body) return notFound();
    return new Response(new Uint8Array(asset.body), {
      status: 200,
      headers: { 'Content-Type': asset.contentType },
    });
  });

  app.on('get', '/app-icon.svg', () => {
    const asset = serveUiFile('app-icon.svg');
    if (asset.status === 404 || !asset.body) return notFound();
    return new Response(new Uint8Array(asset.body), {
      status: 200,
      headers: { 'Content-Type': asset.contentType },
    });
  });

  // SPA deep-link fallback: GET-only (h3 serves HEAD off the GET route). Other
  // methods must not receive `index.html` — a POST/PUT/DELETE to an unknown or
  // unmatched `/api` path falls through with no route and gets h3's JSON 404,
  // not a misleading 200 HTML body for a missed mutation.
  app.on('get', '/**', (event) => {
    const basePath = resolveBasePath(core.options.basePath, event.url.pathname);
    const html = renderIndexHtml(basePath, core.options.title || 'Workbench');
    return new Response(html.body, {
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    });
  });

  return app;
}
