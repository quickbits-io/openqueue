import { H3 } from 'h3';
import { describe, expect, it } from 'vitest';
import { cors } from '../cors';

// The h3 migration hand-rolled `cors` to intercept the downstream Response and
// set `Access-Control-Allow-Origin` on it, rather than preparing the header via
// `event.res.headers` — because h3 only merges prepared headers onto 2xx, while
// `hono/cors` attached CORS to EVERY response, including 4xx validation errors.
// This locks in that deviation, and confirms the one status class where it does
// NOT apply (a thrown handler → 500) still matches Hono, whose post-`next()`
// header write is likewise skipped when the downstream throws.
describe('cors interceptor — status-independent ACAO (hono/cors parity)', () => {
  function app(): H3 {
    const a = new H3();
    a.use('/api/**', cors);
    a.on('get', '/api/ok', () => new Response('ok', { status: 200 }));
    a.on('get', '/api/bad', () => new Response('bad', { status: 400 }));
    a.on('get', '/api/boom', () => {
      throw new Error('boom');
    });
    return a;
  }

  it('attaches ACAO to a 2xx response', async () => {
    const res = await app().request('/api/ok');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('attaches ACAO to a 4xx response (the reason the interceptor exists)', async () => {
    const res = await app().request('/api/bad');
    expect(res.status).toBe(400);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('does NOT attach ACAO when the handler throws (500) — matching Hono', async () => {
    // The throw propagates through `await next()`, so the interceptor's header
    // write never runs; h3's top-level error boundary produces the 500 bare.
    // Hono behaved identically: its cors sets headers only after `await next()`
    // returns, so a thrown handler yields a 500 with no CORS headers.
    const res = await app().request('/api/boom');
    expect(res.status).toBe(500);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
