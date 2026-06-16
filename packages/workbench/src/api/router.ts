import { createRoute, OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import { Scalar } from '@scalar/hono-api-reference';
import type { Context } from 'hono';
import type { WorkbenchCore } from '../core/workbench';
import { buildRouteTable, type HandlerInput, type RouteDef } from './handlers';
import { errorResponseSchema } from './schemas';

/** Convert Hono-style `:param` paths to OpenAPI `{param}` paths. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/** Build a `@hono/zod-openapi` route definition from a route's `meta`. */
function routeConfig(route: RouteDef, meta: NonNullable<RouteDef['meta']>) {
  const request: RouteConfig['request'] = {};
  if (meta.params) request.params = meta.params;
  if (meta.query) request.query = meta.query;
  if (meta.body) {
    request.body = { content: { 'application/json': { schema: meta.body } } };
  }

  const successStatus = meta.status ?? 200;
  const responses: RouteConfig['responses'] = {
    [successStatus]: {
      description: 'Success',
      ...(meta.response && {
        content: { 'application/json': { schema: meta.response } },
      }),
    },
    400: {
      description: 'Validation or request error',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  };

  return createRoute({
    method: route.method,
    path: toOpenApiPath(route.path),
    tags: meta.tags,
    summary: meta.summary,
    request,
    responses,
  });
}

/** Run a route's framework-agnostic handler from a Hono request context. */
async function dispatch(route: RouteDef, c: Context): Promise<Response> {
  const input: HandlerInput = {
    params: c.req.param(),
    query: c.req.query(),
    body: route.meta?.body
      ? await c.req.json().catch(() => undefined)
      : undefined,
  };
  const result = await route.handler(input);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Create API routes for Workbench as an `OpenAPIHono` app.
 *
 * Each route in the framework-agnostic `buildRouteTable(core)` is registered
 * with its zod `meta`, so `@hono/zod-openapi` validates requests and generates
 * the OpenAPI document — served at `/openapi.json` with an interactive Scalar
 * reference at `/reference`.
 */
export function createApiRoutes(core: WorkbenchCore): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: 'Invalid request',
            issues: result.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
          400,
        );
      }
    },
  });

  app.get(
    '/reference',
    Scalar({
      url: 'openapi.json',
      pageTitle: 'OpenQueue Workbench API',
      // Defaults to Scalar's CDN; set `scalarCdn` to a self-hosted bundle for
      // a fully offline reference page.
      cdn: core.options.scalarCdn,
    }),
  );

  for (const route of buildRouteTable(core)) {
    if (route.meta) {
      app.openapi(routeConfig(route, route.meta), (c) => dispatch(route, c));
    } else {
      app.on(route.method.toUpperCase(), route.path, (c) => dispatch(route, c));
    }
  }

  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'OpenQueue Workbench API',
      version: '0.1.0',
      description:
        'HTTP API powering the OpenQueue Workbench dashboard — queues, runs, schedules, flows, metrics, and alerts.',
    },
  });

  return app;
}
