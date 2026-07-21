import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { WorkbenchCore } from '../core/workbench';
import { createApiRoutes } from './router';

function core(scalarCdn?: string): WorkbenchCore {
  return new WorkbenchCore({
    queues: [],
    alerts: { delivery: false },
    scalarCdn,
  });
}

// Structural OpenAPI 3.1 validation of the self-generated document served at
// `GET /openapi.json` (no metaschema validator is bundled, so this zod schema
// pins the shape the migration replaced `@hono/zod-openapi` with).
const jsonSchema = z.record(z.string(), z.unknown());
const parameter = z.object({
  name: z.string(),
  in: z.enum(['path', 'query']),
  required: z.boolean(),
  schema: jsonSchema,
});
const operation = z.object({
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  parameters: z.array(parameter).optional(),
  requestBody: z
    .object({
      required: z.literal(true),
      content: z.object({
        'application/json': z.object({ schema: jsonSchema }),
      }),
    })
    .optional(),
  responses: z.record(
    z.string(),
    z.object({ description: z.string(), content: jsonSchema.optional() }),
  ),
});
const openApiDocument = z.object({
  openapi: z.literal('3.1.0'),
  info: z.object({
    title: z.string(),
    version: z.string(),
    description: z.string().optional(),
  }),
  paths: z.record(z.string(), z.record(z.string(), operation)),
});

describe('GET /openapi.json (served)', () => {
  it('serves an OpenAPI 3.1 document that parses against the structural schema', async () => {
    const res = await createApiRoutes(core()).request('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const doc = openApiDocument.parse(await res.json());
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBeGreaterThan(0);
    // OpenAPI path templating: no leftover rou3 `:param` segments.
    expect(paths.every((path) => !path.includes(':'))).toBe(true);
    // Every documented operation carries the shared 400 error response.
    for (const item of Object.values(doc.paths)) {
      for (const op of Object.values(item)) {
        expect(Object.keys(op.responses)).toContain('400');
      }
    }
  });
});

describe('GET /reference (served)', () => {
  it('renders the Scalar bootstrap pointing at openapi.json (default CDN)', async () => {
    const res = await createApiRoutes(core()).request('/reference');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    const html = await res.text();
    expect(html).toContain('id="api-reference"');
    expect(html).toContain('data-url="openapi.json"');
    expect(html).toContain('cdn.jsdelivr.net/npm/@scalar/api-reference');
  });

  it('honors a custom scalarCdn', async () => {
    const res = await createApiRoutes(
      core('https://example.test/scalar.js'),
    ).request('/reference');
    const html = await res.text();
    expect(html).toContain('src="https://example.test/scalar.js"');
    expect(html).not.toContain('cdn.jsdelivr.net');
  });
});
