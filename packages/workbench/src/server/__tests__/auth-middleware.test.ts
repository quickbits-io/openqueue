import { apiKey } from '@openqueue/core';
import { H3 } from 'h3';
import { describe, expect, it } from 'vitest';
import type { WorkbenchOptions } from '../../core/types';
import { workbenchAuthMiddleware } from '../auth-middleware';

function appWith(auth: WorkbenchOptions['auth']): H3 {
  const middleware = workbenchAuthMiddleware(auth);
  const app = new H3();
  if (middleware) app.use(middleware);
  app.get('/', () => 'ok');
  return app;
}

describe('workbenchAuthMiddleware', () => {
  it('returns undefined when auth is off', () => {
    expect(workbenchAuthMiddleware(undefined)).toBeUndefined();
  });

  it('accepts valid basic credentials (sugar form)', async () => {
    const app = appWith({ username: 'admin', password: 'pw' });
    const res = await app.request('/', {
      headers: { Authorization: `Basic ${btoa('admin:pw')}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects invalid basic credentials with a Basic realm challenge', async () => {
    const app = appWith({ username: 'admin', password: 'pw' });
    const res = await app.request('/');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Basic realm="Workbench"');
    expect(await res.text()).toBe('Unauthorized');
  });

  it('runs an ordered strategy walk (array form) with a Bearer challenge', async () => {
    const app = appWith([apiKey('tok')]);
    const good = await app.request('/', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(good.status).toBe(200);

    const bad = await app.request('/', {
      headers: { Authorization: 'Bearer no' },
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('fails closed on an empty strategy array', async () => {
    const app = appWith([]);
    expect((await app.request('/')).status).toBe(401);
  });

  it('treats empty basic credentials as auth-off, not a lock-out', async () => {
    // Matches WorkbenchCore.requiresAuth: env-derived empty strings mean the
    // dashboard is open, not 401-locked.
    expect(
      workbenchAuthMiddleware({ username: '', password: '' }),
    ).toBeUndefined();
    const app = appWith({ username: '', password: '' });
    expect((await app.request('/')).status).toBe(200);
  });

  it('treats a partially-filled credentials form as auth-off', () => {
    expect(
      workbenchAuthMiddleware({ username: 'admin', password: '' }),
    ).toBeUndefined();
    expect(
      workbenchAuthMiddleware({ username: '', password: 'pw' }),
    ).toBeUndefined();
  });
});
