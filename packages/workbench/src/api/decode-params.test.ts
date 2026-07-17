import type {
  QueueRunsApi,
  QueueSchedule,
  QueueSchedulesApi,
} from '@openqueue/core';
import { describe, expect, it } from 'vitest';
import type { WorkbenchSchedulesStorage } from '../core/types';
import { WorkbenchCore } from '../core/workbench';
import { decodeParams } from './decode-params';
import { createApiRoutes } from './router';
import { buildControlApp } from './v1/app';
import type { ControlApiOptions } from './v1/routes';

// rou3 (h3's router) delivers matched path params raw/percent-encoded, whereas
// Hono `decodeURIComponent`-decoded them. `decodeParams` restores that so a
// user-supplied id reaching a path segment (a custom `jobId` used as a run id,
// a schedule id) matches its lookup again.
describe('decodeParams', () => {
  it('decodes percent-encoded values, including URI-reserved chars', () => {
    expect(decodeParams({ id: 'my%20id' })).toEqual({ id: 'my id' });
    expect(decodeParams({ id: '%E2%9C%93' })).toEqual({ id: '✓' });
    // decodeURI leaves `%2F` encoded; Hono parity needs decodeURIComponent.
    expect(decodeParams({ id: 'a%2Fb' })).toEqual({ id: 'a/b' });
    expect(decodeParams({ queue: 'q', id: 'x%20y' })).toEqual({
      queue: 'q',
      id: 'x y',
    });
  });

  it('falls back to the raw value on a malformed escape (no throw)', () => {
    // decodeURIComponent('%E0%A4%A') throws — the raw value is kept instead.
    expect(() => decodeParams({ id: '%E0%A4%A' })).not.toThrow();
    expect(decodeParams({ id: '%E0%A4%A' })).toEqual({ id: '%E0%A4%A' });
  });

  it('returns an empty object when there are no params', () => {
    expect(decodeParams(undefined)).toEqual({});
  });
});

const notImplemented = () => {
  throw new Error('not implemented');
};

function controlOptions(capture: (id: string) => void): ControlApiOptions {
  const runs: QueueRunsApi = {
    list: async () => ({ data: [], hasMore: false }),
    retrieve: async (id) => {
      capture(id);
      return undefined;
    },
    poll: notImplemented,
    cancel: async () => ({ outcome: 'not_found' }),
  };
  const schedules: QueueSchedulesApi = {
    create: notImplemented,
    retrieve: notImplemented,
    list: async () => [],
    runNow: notImplemented,
    update: notImplemented,
    activate: notImplemented,
    deactivate: notImplemented,
    delete: async () => false,
    timezones: async () => ['UTC'],
  };
  return {
    runtime: {
      trigger: notImplemented,
      runs,
      schedules,
      catalog: { read: async () => [], resolve: async () => undefined },
    },
    auth: { token: 'secret' },
    info: { namespace: 'test' },
  };
}

function scheduleStorage(
  capture: (id: string) => void,
): WorkbenchSchedulesStorage {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const schedule: QueueSchedule = {
    id: 's1',
    type: 'IMPERATIVE',
    task: 'echo',
    active: true,
    cron: '* * * * *',
    timezone: 'UTC',
    meta: {},
    createdAt: now,
    updatedAt: now,
  };
  return {
    list: async () => [],
    retrieve: async (id) => {
      capture(id);
      return schedule;
    },
    runNow: notImplemented,
    activate: notImplemented,
    deactivate: notImplemented,
    delete: async () => false,
  };
}

function dashboardApp(capture: (id: string) => void) {
  const core = new WorkbenchCore({
    queues: [],
    alerts: { enabled: false },
    queue: { schedules: scheduleStorage(capture) },
  });
  return createApiRoutes(core);
}

describe('path param decode parity through the h3 dispatch', () => {
  const authed = { headers: { Authorization: 'Bearer secret' } };

  it('control API decodes params before the handler (GET /runs/:id)', async () => {
    const seen: string[] = [];
    const app = buildControlApp(controlOptions((id) => seen.push(id)));

    // Stub retrieve returns undefined → 404, proving the (decoded) id reached
    // the handler and the lookup ran.
    expect((await app.request('/runs/my%20id', authed)).status).toBe(404);
    expect((await app.request('/runs/%E2%9C%93', authed)).status).toBe(404);
    expect(seen).toEqual(['my id', '✓']);
  });

  it('dashboard API decodes params before the handler (GET /schedules/:id)', async () => {
    const seen: string[] = [];
    const app = dashboardApp((id) => seen.push(id));

    expect((await app.request('/schedules/my%20id')).status).toBe(200);
    expect((await app.request('/schedules/%E2%9C%93')).status).toBe(200);
    expect(seen).toEqual(['my id', '✓']);
  });

  // h3 rejects a fully-malformed URL escape at the request layer (kMalformedURL
  // → 400) before dispatch, so a malformed sequence never 500s. `decodeParams`'
  // own try/catch fallback (covered above) is the belt to that suspenders.
  it('h3 answers a malformed escape with 400 before the handler runs', async () => {
    const seen: string[] = [];
    const control = buildControlApp(controlOptions((id) => seen.push(id)));
    expect((await control.request('/runs/%E0%A4%A', authed)).status).toBe(400);
    expect(seen).toEqual([]);

    const dash = dashboardApp((id) => seen.push(id));
    expect((await dash.request('/schedules/%E0%A4%A')).status).toBe(400);
  });
});
