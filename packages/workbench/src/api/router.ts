import { H3, type H3Event } from 'h3';
import type { z } from 'zod';
import type { WorkbenchCore } from '../core/workbench';
import { decodeParams } from './decode-params';
import { buildRouteTable, type RouteDef, type RouteMeta } from './handlers';
import { buildOpenApiDocument, type OpenApiInfo } from './openapi';

const OPENAPI_INFO: OpenApiInfo = {
  title: 'OpenQueue Workbench API',
  version: '0.1.0',
  description:
    'HTTP API powering the OpenQueue Workbench dashboard — queues, runs, schedules, flows, metrics, and alerts.',
};

const DEFAULT_SCALAR_CDN = 'https://cdn.jsdelivr.net/npm/@scalar/api-reference';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface ValidationError {
  error: string;
  issues: { path: string; message: string }[];
}

/** Validate one request part; on failure return the shared 400 envelope. */
function check(
  schema: z.ZodType | undefined,
  value: unknown,
): ValidationError | undefined {
  if (!schema) return undefined;
  const result = schema.safeParse(value);
  if (result.success) return undefined;
  return {
    error: 'Invalid request',
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}

/**
 * Replicate `@hono/zod-openapi`'s pre-handler validation: params, then query,
 * then body; the first failing part yields the 400 envelope.
 */
function validate(
  meta: RouteMeta,
  params: unknown,
  query: unknown,
  body: unknown,
): ValidationError | undefined {
  return (
    check(meta.params, params) ??
    check(meta.query, query) ??
    check(meta.body, body)
  );
}

async function dispatch(route: RouteDef, event: H3Event): Promise<Response> {
  const params = decodeParams(event.context.params);
  const query = Object.fromEntries(event.url.searchParams);
  const body = route.meta?.body
    ? await event.req.json().catch(() => undefined)
    : undefined;

  if (route.meta) {
    const invalid = validate(route.meta, params, query, body);
    if (invalid) return json(invalid, 400);
  }

  const result = await route.handler({ params, query, body });
  return json(result.body, result.status);
}

/** Minimal Scalar CDN bootstrap; `openapi.json` is served alongside `/reference`. */
function referenceHtml(cdn: string | undefined): string {
  return `<!doctype html>
<html>
  <head>
    <title>OpenQueue Workbench API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <script id="api-reference" data-url="openapi.json"></script>
    <script src="${cdn ?? DEFAULT_SCALAR_CDN}"></script>
  </body>
</html>`;
}

/**
 * Create the Workbench API as an h3 app. Each route in the framework-agnostic
 * `buildRouteTable(core)` is registered with per-request validation from its zod
 * `meta`; `GET /openapi.json` self-generates the OpenAPI 3.1 document from the
 * same table, and `GET /reference` serves an interactive Scalar page.
 */
export function createApiRoutes(core: WorkbenchCore): H3 {
  const app = new H3();
  const routes = buildRouteTable(core);

  app.on('get', '/openapi.json', () =>
    json(buildOpenApiDocument(routes, OPENAPI_INFO)),
  );
  app.on(
    'get',
    '/reference',
    () =>
      new Response(referenceHtml(core.options.scalarCdn), {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' },
      }),
  );

  for (const route of routes) {
    app.on(route.method, route.path, (event) => dispatch(route, event));
  }

  return app;
}
