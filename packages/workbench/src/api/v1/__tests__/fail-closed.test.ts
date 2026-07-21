import type { QueueRunsApi, QueueSchedulesApi } from '@openqueue/core';
import { H3 } from 'h3';
import { describe, expect, it } from 'vitest';
import { buildControlApp } from '../app';
import type { ControlApiOptions } from '../routes';

const runs: QueueRunsApi = {
  list: async () => ({ data: [], hasMore: false }),
  retrieve: async () => undefined,
  poll: async () => {
    throw new Error('not implemented');
  },
  cancel: async () => ({ outcome: 'not_found' }),
};

const schedules: QueueSchedulesApi = {
  create: async () => {
    throw new Error('not implemented');
  },
  retrieve: async (id) => {
    throw new Error(`Unknown queue schedule "${id}"`);
  },
  list: async () => [],
  runNow: async () => {
    throw new Error('not implemented');
  },
  update: async (id) => {
    throw new Error(`Unknown queue schedule "${id}"`);
  },
  activate: async (id) => {
    throw new Error(`Unknown queue schedule "${id}"`);
  },
  deactivate: async (id) => {
    throw new Error(`Unknown queue schedule "${id}"`);
  },
  delete: async () => false,
  timezones: async () => ['UTC'],
};

function options(): ControlApiOptions {
  return {
    runtime: {
      catalog: { read: async () => [], resolve: async () => undefined },
      trigger: async () => ({
        runId: 'r1',
        jobId: 'j1',
      }),
      runs,
      schedules,
    },
    auth: { token: 'secret' },
    info: { namespace: 'test' },
  };
}

// h3 runs global middleware before route matching, so an unauthenticated request
// to an UNKNOWN path is rejected by the auth walk (401) rather than falling
// through to a 404 — this is the fail-closed property the registration-order
// health skip used to give us. Verified standalone AND under `.mount`.
describe('control API fail-closed before 404', () => {
  it('401s an unauthenticated unknown path (standalone)', async () => {
    const app = buildControlApp(options());
    const res = await app.request('/does-not-exist');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('keeps /health public (standalone)', async () => {
    const res = await buildControlApp(options()).request('/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('404s an authenticated unknown path with the wire envelope (standalone)', async () => {
    // The mounted counterpart is covered below; this pins the same `/**`
    // catch-all envelope for a bare (unmounted) control app.
    const res = await buildControlApp(options()).request('/does-not-exist', {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    });
  });

  it('401s an unauthenticated unknown path (mounted)', async () => {
    const host = new H3().mount('/openqueue/v1', buildControlApp(options()));
    const res = await host.request('/openqueue/v1/does-not-exist');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('keeps /health public under mount, and 404s only when authenticated', async () => {
    const host = new H3().mount('/openqueue/v1', buildControlApp(options()));
    expect((await host.request('/openqueue/v1/health')).status).toBe(200);

    // With a valid token the auth walk passes, so an unknown path now reaches
    // the `/**` catch-all, which returns the wire 404 envelope — no longer 401.
    const authed = await host.request('/openqueue/v1/does-not-exist', {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(authed.status).toBe(404);
    await expect(authed.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    });
  });
});
