import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createClient } from '@openqueue/client';
import {
  clientErrorFrom,
  startLockedWorker,
  startTestWorker,
  type TestWorker,
} from '../harness';

describe('token-protected worker', () => {
  let w: TestWorker;

  beforeAll(async () => {
    w = await startTestWorker();
  });

  afterAll(async () => {
    await w.close();
  });

  test('a no-auth client is rejected as unauthorized', async () => {
    const anon = createClient({ host: w.url });
    const error = await clientErrorFrom(anon.catalog.read());
    expect(error.code).toBe('unauthorized');
  });

  test('a wrong bearer token is rejected as unauthorized', async () => {
    const wrong = createClient({ host: w.url, auth: { bearer: 'nope' } });
    const error = await clientErrorFrom(wrong.catalog.read());
    expect(error.code).toBe('unauthorized');
  });

  test('a raw unauthenticated request returns the 401 envelope + challenge', async () => {
    const res = await fetch(`${w.url}/openqueue/v1/catalog`);
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
    expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
  });
});

describe('locked worker (production, no token)', () => {
  let w: TestWorker;

  beforeAll(async () => {
    w = await startLockedWorker();
  });

  afterAll(async () => {
    await w.close();
  });

  test('health stays public even when locked', async () => {
    const res = await fetch(`${w.url}/openqueue/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('catalog is locked even with a bearer, and the message points at api.token', async () => {
    const res = await fetch(`${w.url}/openqueue/v1/catalog`, {
      headers: { Authorization: 'Bearer anything' },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toContain('api.token');
  });
});
