import type {
  AuthStrategy,
  Principal,
  QueueRunListOptions,
  QueueRunsApi,
  QueueSchedulesApi,
} from '@openqueue/core';
import { H3 } from 'h3';
import { describe, expect, it } from 'vitest';
import { buildControlApp } from '../app';
import type { ControlApiOptions } from '../routes';

const notImpl = () => {
  throw new Error('not implemented');
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function schedules(): QueueSchedulesApi {
  return {
    create: notImpl,
    retrieve: notImpl,
    list: async () => [],
    runNow: notImpl,
    update: notImpl,
    activate: notImpl,
    deactivate: notImpl,
    delete: async () => false,
    timezones: async () => ['UTC'],
  };
}

function baseRuns(): QueueRunsApi {
  return {
    list: async () => ({ data: [], hasMore: false }),
    retrieve: async () => undefined,
    poll: notImpl,
    cancel: async () => ({ outcome: 'not_found' }),
  };
}

function tokenOptions(runs: QueueRunsApi = baseRuns()): ControlApiOptions {
  return {
    runtime: {
      trigger: notImpl,
      runs,
      schedules: schedules(),
      catalog: { read: async () => [], resolve: async () => undefined },
    },
    auth: { token: 'secret' },
    info: { namespace: 'test' },
  };
}

const authed = { headers: { Authorization: 'Bearer secret' } };

// The h3 middleware bypasses auth only for the exact pathname `/health`
// (registration-order health-first ordering does not port to h3). Every
// near-miss must still hit the auth walk and fail closed.
describe('control health-bypass is exact-match only', () => {
  it('serves the exact /health publicly', async () => {
    expect(
      (await buildControlApp(tokenOptions()).request('/health')).status,
    ).toBe(200);
  });

  it('requires auth on every /health near-miss', async () => {
    const app = buildControlApp(tokenOptions());
    for (const path of [
      '/health%2F',
      '/HEALTH',
      '/healthx',
      '//health',
      '/health/',
    ]) {
      const res = await app.request(path);
      expect(res.status, `${path} must require auth`).toBe(401);
    }
  });

  it('keeps the exact-match bypass under .mount (base is stripped first)', async () => {
    const host = new H3().mount(
      '/openqueue/v1',
      buildControlApp(tokenOptions()),
    );
    expect((await host.request('/openqueue/v1/health')).status).toBe(200);
    expect((await host.request('/openqueue/v1/HEALTH')).status).toBe(401);
    expect((await host.request('/openqueue/v1/health%2F')).status).toBe(401);
  });
});

// h3 runs global middleware before route matching, so even a method with no
// registered route on the control app fails closed at auth rather than reaching
// a 404/405.
describe('control fail-closed at the method edge', () => {
  it('401s an unauthenticated OPTIONS to an unknown path', async () => {
    const res = await buildControlApp(tokenOptions()).request(
      '/does-not-exist',
      {
        method: 'OPTIONS',
      },
    );
    expect(res.status).toBe(401);
  });
});

// rou3 keeps a percent-encoded slash as a single path segment (it does NOT split
// on `%2F`), so `/runs/a%2Fb` matches `/runs/:id` and `decodeParams` restores the
// raw id to `a/b` before the handler — the same shape Hono produced.
describe('rou3 percent-encoded slash routing', () => {
  it('routes /runs/a%2Fb to :id and decodes to a/b (not a 404 at the router)', async () => {
    const seen: string[] = [];
    const runs: QueueRunsApi = {
      ...baseRuns(),
      retrieve: async (id) => {
        seen.push(id);
        return undefined;
      },
    };
    const res = await buildControlApp(tokenOptions(runs)).request(
      '/runs/a%2Fb',
      authed,
    );
    // 404 comes from the stub `retrieve` returning undefined — proving the
    // request reached the handler, not the router's no-match 404.
    expect(res.status).toBe(404);
    expect(seen).toEqual(['a/b']);
  });
});

// The verified principal is passed from the auth middleware to the handler
// through a closure-scoped `WeakMap<H3Event, Principal>`. Under interleaved
// concurrent requests each event is a distinct key, so no principal bleeds from
// one tenant's request into another's.
describe('WeakMap principal isolation under concurrency', () => {
  // Maps the bearer token to a tenant-scoped principal, yielding first so every
  // in-flight request has set its principal before any handler runs — the worst
  // case for a shared (non-WeakMap) slot.
  const tenantStrategy: AuthStrategy = async (request) => {
    const header = request.headers.get('authorization');
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (token === undefined) return null;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const principal: Principal = {
      authenticator: 'api-key',
      principalId: token,
      principalType: 'service',
      tenantId: token,
      attributes: {},
    };
    return principal;
  };

  function concurrencyOptions(): ControlApiOptions {
    const runs: QueueRunsApi = {
      ...baseRuns(),
      // GET /runs threads the principal into the list filter via
      // scopeMetaFilter; echo its tenant back through `cursor` so the response
      // reveals which principal the handler actually saw.
      list: async (options?: QueueRunListOptions) => {
        const enqueuedBy = options?.meta?.enqueuedBy;
        const tenantId =
          isRecord(enqueuedBy) && typeof enqueuedBy.tenantId === 'string'
            ? enqueuedBy.tenantId
            : undefined;
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { data: [], hasMore: false, cursor: tenantId };
      },
    };
    return {
      runtime: {
        trigger: notImpl,
        runs,
        schedules: schedules(),
        catalog: { read: async () => [], resolve: async () => undefined },
      },
      auth: { strategies: [tenantStrategy] },
      info: { namespace: 'test' },
    };
  }

  it('each concurrent request sees only its own principal', async () => {
    const app = buildControlApp(concurrencyOptions());
    const tokens = ['tenant-a', 'tenant-b', 'tenant-c', 'tenant-d'];
    const results = await Promise.all(
      tokens.map(async (token) => {
        const res = await app.request('/runs', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = await res.json();
        const cursor =
          isRecord(body) && typeof body.cursor === 'string'
            ? body.cursor
            : undefined;
        return { token, cursor };
      }),
    );
    for (const { token, cursor } of results) {
      expect(cursor, `request ${token} must see its own principal`).toBe(token);
    }
  });
});
