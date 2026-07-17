import { describe, expect, it } from 'vitest';
import { WorkbenchCore } from '../core/workbench';
import { buildRouteTable } from './handlers';
import { buildOpenApiDocument } from './openapi';

const INFO = {
  title: 'OpenQueue Workbench API',
  version: '0.1.0',
  description: 'HTTP API powering the OpenQueue Workbench dashboard.',
};

function document() {
  // `alerts.delivery: false` keeps the alert routes registered (full table)
  // without starting the delivery poller.
  const core = new WorkbenchCore({ queues: [], alerts: { delivery: false } });
  return buildOpenApiDocument(buildRouteTable(core), INFO);
}

describe('buildOpenApiDocument', () => {
  const doc = document();

  it('is an OpenAPI 3.1 document carrying the provided info block', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info).toEqual(INFO);
  });

  it('emits every route with meta and no leftover :params in path keys', () => {
    const paths = Object.keys(doc.paths);
    expect(paths.length).toBe(41);
    expect(paths.every((p) => !p.includes(':'))).toBe(true);

    const operations = paths.flatMap((p) => Object.keys(doc.paths[p]!));
    expect(operations.length).toBe(47);
  });

  it('carries required path params, query params, bodies, and the shared 400', () => {
    const jobs = doc.paths['/queues/{name}/jobs']?.get;
    expect(jobs?.parameters).toContainEqual(
      expect.objectContaining({ name: 'name', in: 'path', required: true }),
    );
    expect(jobs?.parameters?.some((p) => p.in === 'query')).toBe(true);
    expect(Object.keys(jobs?.responses ?? {})).toEqual(['200', '400']);

    const test = doc.paths['/test']?.post;
    expect(test?.requestBody?.required).toBe(true);
    expect(Object.keys(test?.responses ?? {})).toEqual(['200', '400']);

    // meta.status is honored (201 for creates).
    const createContact = doc.paths['/alerts/contact-points']?.post;
    expect(Object.keys(createContact?.responses ?? {})).toEqual(['201', '400']);

    const delSchedule = doc.paths['/schedules/{id}']?.delete;
    expect(delSchedule?.parameters).toContainEqual(
      expect.objectContaining({ name: 'id', in: 'path', required: true }),
    );
  });
});
