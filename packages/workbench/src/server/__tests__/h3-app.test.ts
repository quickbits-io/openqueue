import { H3 } from 'h3';
import { describe, expect, it } from 'vitest';
import { WorkbenchCore } from '../../core/workbench';
import { buildWorkbenchApp } from '../h3-app';

function core() {
  return new WorkbenchCore({ queues: [], alerts: { enabled: false } });
}

describe('buildWorkbenchApp — rou3 root matching', () => {
  // MUST-VERIFY (blueprint): the `/**` catch-all must match the app root and a
  // bare mount base. Verified true, so no explicit `/` alias route is needed.
  it('serves index.html at the root via the /** catch-all', async () => {
    const res = await buildWorkbenchApp(core()).request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=UTF-8');
  });

  it('lets static routes win over the catch-all', async () => {
    const res = await buildWorkbenchApp(core()).request('/config');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('serves index at the bare mount base and below it', async () => {
    const host = new H3().mount('/workbench', buildWorkbenchApp(core()));
    for (const path of [
      '/workbench',
      '/workbench/',
      '/workbench/queues/email',
    ]) {
      const res = await host.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=UTF-8');
    }
  });
});

describe('buildWorkbenchApp — wire parity', () => {
  it('sets Access-Control-Allow-Origin on API GETs', async () => {
    const res = await buildWorkbenchApp(core()).request('/api/queue-names', {
      headers: { Origin: 'http://example.com' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('answers an OPTIONS preflight with the hono/cors default bytes', async () => {
    const res = await buildWorkbenchApp(core()).request('/api/queue-names', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, authorization',
      },
    });
    expect(res.status).toBe(204);
    expect(res.statusText).toBe('No Content');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toBe(
      'GET,HEAD,PUT,POST,DELETE,PATCH',
    );
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'content-type,authorization',
    );
    expect(res.headers.get('vary')).toBe('Access-Control-Request-Headers');
    expect(await res.text()).toBe('');
  });

  it('returns the 400 validation envelope on an invalid body', async () => {
    const res = await buildWorkbenchApp(core()).request('/api/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = await res.json();
    expect(body.error).toBe('Invalid request');
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues.length).toBeGreaterThan(0);
    expect(body.issues[0]).toHaveProperty('path');
    expect(body.issues[0]).toHaveProperty('message');
  });

  it('serves a text/plain 404 for a missing asset', async () => {
    const res = await buildWorkbenchApp(core()).request('/assets/missing.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
    expect(await res.text()).toBe('Not found');
  });
});
