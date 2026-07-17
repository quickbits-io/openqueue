/**
 * Framework-free OpenAPI 3.1 generation from the Workbench {@link RouteDef}
 * table. OpenAPI 3.1 aligns with JSON Schema 2020-12, which is exactly what
 * zod v4's {@link z.toJSONSchema} emits, so each route's zod `meta` becomes the
 * document without a Hono/zod-openapi dependency.
 *
 * Routes without `meta` are omitted (they carry no schema to document), matching
 * the previous `@hono/zod-openapi` behavior.
 */
import { z } from 'zod';
import type { RouteDef, RouteMeta } from './handlers';
import { errorResponseSchema } from './schemas';

export interface OpenApiInfo {
  title: string;
  version: string;
  description?: string;
}

/** JSON Schema for a zod type, dropping the redundant per-schema `$schema` URI. */
function jsonSchema(schema: z.ZodType) {
  const result = z.toJSONSchema(schema);
  delete result.$schema;
  return result;
}

type JsonSchema = ReturnType<typeof jsonSchema>;

type HttpMethod = RouteDef['method'];

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query';
  required: boolean;
  schema: JsonSchema;
}

interface OpenApiBody {
  'application/json': { schema: JsonSchema };
}

interface OpenApiResponse {
  description: string;
  content?: OpenApiBody;
}

interface OpenApiOperation {
  summary?: string;
  tags?: string[];
  parameters?: OpenApiParameter[];
  requestBody?: { required: true; content: OpenApiBody };
  responses: Record<string, OpenApiResponse>;
}

type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>>;

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: OpenApiInfo;
  paths: Record<string, OpenApiPathItem>;
}

/** Convert `:param` paths to OpenAPI `{param}` paths. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function collect(
  into: OpenApiParameter[],
  where: 'path' | 'query',
  object: z.ZodObject,
): void {
  const shape: Record<string, z.ZodType> = object.shape;
  for (const [name, prop] of Object.entries(shape)) {
    into.push({
      name,
      in: where,
      required: !prop.safeParse(undefined).success,
      schema: jsonSchema(prop),
    });
  }
}

function parameters(meta: RouteMeta): OpenApiParameter[] | undefined {
  const params: OpenApiParameter[] = [];
  if (meta.params) collect(params, 'path', meta.params);
  if (meta.query) collect(params, 'query', meta.query);
  return params.length > 0 ? params : undefined;
}

function responses(meta: RouteMeta): Record<string, OpenApiResponse> {
  const success: OpenApiResponse = { description: 'Success' };
  if (meta.response) {
    success.content = {
      'application/json': { schema: jsonSchema(meta.response) },
    };
  }
  return {
    [String(meta.status ?? 200)]: success,
    '400': {
      description: 'Validation or request error',
      content: {
        'application/json': { schema: jsonSchema(errorResponseSchema) },
      },
    },
  };
}

function operation(meta: RouteMeta): OpenApiOperation {
  const op: OpenApiOperation = { responses: responses(meta) };
  if (meta.summary) op.summary = meta.summary;
  if (meta.tags) op.tags = meta.tags;
  const params = parameters(meta);
  if (params) op.parameters = params;
  if (meta.body) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: jsonSchema(meta.body) } },
    };
  }
  return op;
}

/**
 * Build the OpenAPI 3.1 document for a route table. Mirrors the shape the
 * previous `@hono/zod-openapi` pipeline produced: one operation per route with
 * `meta`, path/query parameters with `required` derived from the schema, the
 * success status from `meta.status ?? 200`, and a shared 400 error response.
 */
export function buildOpenApiDocument(
  routes: readonly RouteDef[],
  info: OpenApiInfo,
): OpenApiDocument {
  const paths: Record<string, OpenApiPathItem> = {};
  for (const route of routes) {
    if (!route.meta) continue;
    const path = toOpenApiPath(route.path);
    const item = paths[path] ?? {};
    paths[path] = item;
    item[route.method] = operation(route.meta);
  }
  return { openapi: '3.1.0', info, paths };
}
