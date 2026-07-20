import { createClient } from '@openqueue/client';
import { errorResponseSchema } from '@openqueue/client/wire';
import type {
  CreateQueueScheduleOptions,
  EnqueueOptions,
  EnqueueResult,
  Principal,
  QueueCatalogEntry,
  QueueRun,
  QueueRunListOptions,
  QueueRunsApi,
  QueueSchedule,
  QueueSchedulesApi,
  UpdateQueueScheduleOptions,
} from '@openqueue/core';
import {
  InvalidScheduleError,
  UnknownTaskError,
  UnsupportedCapabilityError,
} from '@openqueue/core/world';
import { describe, expect, it, vi } from 'vitest';
import type { HttpMethod } from '../../handlers';
import { buildControlApp } from '../app';
import { buildControlRouteTable, type ControlApiOptions } from '../routes';
import { toRunListOptions } from '../serialize';

const enqueueResult: EnqueueResult = {
  runId: 'r1',
  jobId: 'j1',
};

function catalogEntry(
  over: Partial<QueueCatalogEntry> = {},
): QueueCatalogEntry {
  return {
    id: 'send-email',
    name: 'send-email',
    queue: 'default',
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    concurrency: 5,
    tags: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: '1',
    ...over,
  };
}

function queueRun(over: Partial<QueueRun> = {}): QueueRun {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'r1',
    task: 'send-email',
    queue: 'default',
    status: 'completed',
    input: {},
    meta: {},
    metadata: {},
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function queueSchedule(over: Partial<QueueSchedule> = {}): QueueSchedule {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 's1',
    type: 'IMPERATIVE',
    task: 'send-email',
    active: true,
    cron: '* * * * *',
    timezone: 'UTC',
    meta: {},
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

function runsApi(over: Partial<QueueRunsApi> = {}): QueueRunsApi {
  return {
    list: async () => ({ data: [], hasMore: false }),
    retrieve: async () => undefined,
    poll: async () => {
      throw new Error('not implemented');
    },
    cancel: async () => ({ outcome: 'not_found' }),
    ...over,
  };
}

function schedulesApi(
  over: Partial<QueueSchedulesApi> = {},
): QueueSchedulesApi {
  return {
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
    ...over,
  };
}

function makeOptions(
  over: {
    catalog?: QueueCatalogEntry[];
    trigger?: ControlApiOptions['runtime']['trigger'];
    runs?: QueueRunsApi;
    schedules?: QueueSchedulesApi;
    token?: string | string[];
  } = {},
): ControlApiOptions {
  const catalog = over.catalog ?? [catalogEntry()];
  return {
    runtime: {
      catalog: {
        read: async () => catalog,
        resolve: async (id) => catalog.find((entry) => entry.id === id),
      },
      trigger: over.trigger ?? (async () => enqueueResult),
      runs: over.runs ?? runsApi(),
      schedules: over.schedules ?? schedulesApi(),
    },
    auth: { token: over.token },
    info: { namespace: 'test' },
  };
}

function handlerFor(
  options: ControlApiOptions,
  method: HttpMethod,
  path: string,
) {
  const route = buildControlRouteTable(options).find(
    (r) => r.method === method && r.path === path,
  );
  if (!route) throw new Error(`no route ${method} ${path}`);
  return route.handler;
}

describe('control routes — jobs', () => {
  it('enqueues a known task and returns 201 with the result', async () => {
    const result = await handlerFor(
      makeOptions(),
      'post',
      '/jobs',
    )({
      params: {},
      query: {},
      body: { task: 'send-email', input: { to: 'x' } },
    });
    expect(result.status).toBe(201);
    expect(result.body).toEqual(enqueueResult);
  });

  it('rejects an unknown task with 404 task_not_found', async () => {
    const result = await handlerFor(
      makeOptions({
        catalog: [],
        trigger: async () => {
          throw new UnknownTaskError('nope');
        },
      }),
      'post',
      '/jobs',
    )({ params: {}, query: {}, body: { task: 'nope', input: {} } });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'task_not_found' } });
  });

  it('resolves through trigger, not a local preflight, so a task missing from the shared catalog is 404 not 500', async () => {
    // Multi-pool: a stale local view still lists the task, but the shared catalog
    // that trigger resolves against no longer has it. The control API must resolve
    // where the enqueue actually happens — surfacing task_not_found, not an
    // internal 500 from a divergent preflight.
    const result = await handlerFor(
      makeOptions({
        catalog: [catalogEntry({ id: 'ghost' })],
        trigger: async () => {
          throw new UnknownTaskError('ghost');
        },
      }),
      'post',
      '/jobs',
    )({ params: {}, query: {}, body: { task: 'ghost', input: {} } });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'task_not_found' } });
  });

  it('enqueues a task absent from the local catalog but resolvable by trigger (cross-pool)', async () => {
    // The task is not in this pool's local catalog, but the shared catalog that
    // trigger resolves against has it. Without a local preflight the namespace-level
    // enqueue succeeds instead of a false task_not_found.
    const result = await handlerFor(
      makeOptions({ catalog: [], trigger: async () => enqueueResult }),
      'post',
      '/jobs',
    )({ params: {}, query: {}, body: { task: 'remote-task', input: {} } });
    expect(result.status).toBe(201);
    expect(result.body).toEqual(enqueueResult);
  });

  it('scopes caller-supplied runId/jobId under the tenant so cross-tenant run clobber is impossible', async () => {
    let captured: EnqueueOptions | undefined;
    const options = makeOptions({
      trigger: async (_task, _input, opts) => {
        captured = opts;
        return enqueueResult;
      },
    });
    await handlerFor(
      options,
      'post',
      '/jobs',
    )({
      params: {},
      query: {},
      body: {
        task: 'send-email',
        input: {},
        options: { runId: 'shared', jobId: 'shared-job' },
      },
      principal: principal('t1'),
    });
    expect(captured?.runId).toBe('t.t1.shared');
    expect(captured?.jobId).toBe('t.t1.shared-job');
    // The scope prefix must be a BullMQ-safe custom job id (no `:` separator).
    expect(captured?.jobId).not.toContain(':');
    expect(captured?.runId).not.toContain(':');
  });

  it('leaves enqueue ids raw for an unscoped (operator) caller', async () => {
    let captured: EnqueueOptions | undefined;
    const options = makeOptions({
      trigger: async (_task, _input, opts) => {
        captured = opts;
        return enqueueResult;
      },
    });
    await handlerFor(
      options,
      'post',
      '/jobs',
    )({
      params: {},
      query: {},
      body: { task: 'send-email', input: {}, options: { runId: 'raw' } },
      principal: principal(),
    });
    expect(captured?.runId).toBe('raw');
  });

  it('rejects an invalid enqueue body with 400 invalid_request and an issues array', async () => {
    const result = await handlerFor(
      makeOptions(),
      'post',
      '/jobs',
    )({
      params: {},
      query: {},
      body: { task: '' },
    });
    expect(result.status).toBe(400);
    const parsed = errorResponseSchema.parse(result.body);
    expect(parsed.error.code).toBe('invalid_request');
    expect(parsed.error.issues?.length).toBeGreaterThan(0);
    expect(parsed.error.issues?.[0]).toMatchObject({ path: 'task' });
  });

  it('passes enqueue options through to the runtime trigger', async () => {
    let captured: EnqueueOptions | undefined;
    const options = makeOptions({
      trigger: async (_task, _input, opts) => {
        captured = opts;
        return enqueueResult;
      },
    });
    const result = await handlerFor(
      options,
      'post',
      '/jobs',
    )({
      params: {},
      query: {},
      body: {
        task: 'send-email',
        input: { to: 'x' },
        options: { delay: 5000, priority: 7 },
      },
    });
    expect(result.status).toBe(201);
    expect(captured).toMatchObject({ delay: 5000, priority: 7 });
  });

  it('maps an UnsupportedCapabilityError from trigger to 501 unsupported_capability', async () => {
    const options = makeOptions({
      trigger: async () => {
        throw new UnsupportedCapabilityError('delay', 'stub-transport');
      },
    });
    const result = await handlerFor(
      options,
      'post',
      '/jobs',
    )({
      params: {},
      query: {},
      body: { task: 'send-email', input: { to: 'x' } },
    });
    expect(result.status).toBe(501);
    const parsed = errorResponseSchema.parse(result.body);
    expect(parsed.error.code).toBe('unsupported_capability');
  });
});

describe('control routes — runs', () => {
  it('parses run list query params and serializes wire runs', async () => {
    let captured: QueueRunListOptions | undefined;
    const options = makeOptions({
      runs: runsApi({
        list: async (o) => {
          captured = o;
          return { data: [queueRun()], hasMore: false };
        },
      }),
    });

    const result = await handlerFor(
      options,
      'get',
      '/runs',
    )({
      params: {},
      query: {
        task: 'send-email',
        status: 'completed',
        meta: JSON.stringify({ tags: ['a'] }),
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-02T00:00:00.000Z',
        sort: 'createdAt:desc',
        limit: '10',
      },
    });

    expect(result.status).toBe(200);
    expect(captured).toMatchObject({
      task: 'send-email',
      status: 'completed',
      meta: { tags: ['a'] },
      sort: { field: 'createdAt', direction: 'desc' },
      limit: 10,
    });
    expect(captured?.timeRange?.start).toBeInstanceOf(Date);
    expect(result.body).toMatchObject({
      data: [{ createdAt: '2026-01-01T00:00:00.000Z' }],
      hasMore: false,
    });
  });

  it('returns 404 when a run is not found', async () => {
    const result = await handlerFor(
      makeOptions(),
      'get',
      '/runs/:id',
    )({
      params: { id: 'missing' },
      query: {},
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'run_not_found' } });
  });

  it('maps cancel outcomes to statuses', async () => {
    const canceled = makeOptions({
      runs: runsApi({
        retrieve: async () => queueRun(),
        cancel: async () => ({
          outcome: 'canceled',
          run: queueRun({ status: 'canceled' }),
        }),
      }),
    });
    const r1 = await handlerFor(
      canceled,
      'post',
      '/runs/:id/cancel',
    )({
      params: { id: 'r1' },
      query: {},
    });
    expect(r1.status).toBe(200);
    expect(r1.body).toMatchObject({ outcome: 'canceled' });

    const finished = makeOptions({
      runs: runsApi({
        retrieve: async () => queueRun(),
        cancel: async () => ({ outcome: 'already_finished', run: queueRun() }),
      }),
    });
    const r2 = await handlerFor(
      finished,
      'post',
      '/runs/:id/cancel',
    )({
      params: { id: 'r1' },
      query: {},
    });
    expect(r2.status).toBe(409);
    expect(r2.body).toMatchObject({ outcome: 'already_finished' });

    const locked = makeOptions({
      runs: runsApi({
        retrieve: async () => queueRun({ status: 'executing' }),
        cancel: async () => ({
          outcome: 'not_cancelable',
          run: queueRun({ status: 'executing' }),
          reason: 'executing',
        }),
      }),
    });
    const r3 = await handlerFor(
      locked,
      'post',
      '/runs/:id/cancel',
    )({
      params: { id: 'r1' },
      query: {},
    });
    expect(r3.status).toBe(409);
    expect(r3.body).toMatchObject({
      outcome: 'not_cancelable',
      reason: 'executing',
    });

    const missing = makeOptions({
      runs: runsApi({ cancel: async () => ({ outcome: 'not_found' }) }),
    });
    const r4 = await handlerFor(
      missing,
      'post',
      '/runs/:id/cancel',
    )({
      params: { id: 'r1' },
      query: {},
    });
    expect(r4.status).toBe(404);
    expect(r4.body).toMatchObject({ error: { code: 'run_not_found' } });
  });

  it('maps an UnsupportedCapabilityError from cancel to 501 unsupported_capability', async () => {
    const options = makeOptions({
      runs: runsApi({
        retrieve: async () => queueRun({ status: 'executing' }),
        cancel: async () => {
          throw new UnsupportedCapabilityError('remove', 'stub-transport');
        },
      }),
    });
    const result = await handlerFor(
      options,
      'post',
      '/runs/:id/cancel',
    )({ params: { id: 'r1' }, query: {} });
    expect(result.status).toBe(501);
    const parsed = errorResponseSchema.parse(result.body);
    expect(parsed.error.code).toBe('unsupported_capability');
  });
});

describe('control routes — schedules', () => {
  it('creates a schedule and returns 201', async () => {
    const schedule = queueSchedule();
    const options = makeOptions({
      schedules: schedulesApi({ create: async () => schedule }),
    });
    const result = await handlerFor(
      options,
      'post',
      '/schedules',
    )({
      params: {},
      query: {},
      body: { task: 'send-email', cron: '* * * * *', deduplicationKey: 'dk' },
    });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      id: 's1',
      createdAt: schedule.createdAt.toISOString(),
    });
  });

  it('returns 404 when deleting a missing schedule', async () => {
    const result = await handlerFor(
      makeOptions(),
      'delete',
      '/schedules/:id',
    )({
      params: { id: 's1' },
      query: {},
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({
      error: { code: 'schedule_not_found' },
    });
  });

  it('returns 404 when a schedule is not found', async () => {
    const result = await handlerFor(
      makeOptions(),
      'get',
      '/schedules/:id',
    )({
      params: { id: 'nope' },
      query: {},
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({
      error: { code: 'schedule_not_found' },
    });
  });

  it('returns 404 when patching an unknown schedule', async () => {
    const result = await handlerFor(
      makeOptions(),
      'patch',
      '/schedules/:id',
    )({
      params: { id: 'nope' },
      query: {},
      body: { cron: '0 * * * *' },
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({
      error: { code: 'schedule_not_found' },
    });
  });

  it('maps a create-time invalid cron to 400 invalid_request', async () => {
    const options = makeOptions({
      schedules: schedulesApi({
        create: async () => {
          throw new InvalidScheduleError('Invalid cron expression "bad"');
        },
      }),
    });
    const result = await handlerFor(
      options,
      'post',
      '/schedules',
    )({
      params: {},
      query: {},
      body: { task: 'send-email', cron: 'bad', deduplicationKey: 'dk' },
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('maps a create-time unknown task to 404 task_not_found', async () => {
    const options = makeOptions({
      schedules: schedulesApi({
        create: async () => {
          throw new UnknownTaskError('ghost');
        },
      }),
    });
    const result = await handlerFor(
      options,
      'post',
      '/schedules',
    )({
      params: {},
      query: {},
      body: { task: 'ghost', cron: '* * * * *', deduplicationKey: 'dk' },
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'task_not_found' } });
  });

  it('maps an update-time invalid cron to 400 invalid_request', async () => {
    const options = makeOptions({
      schedules: schedulesApi({
        retrieve: async () => queueSchedule(),
        update: async () => {
          throw new InvalidScheduleError('Invalid cron expression "bad"');
        },
      }),
    });
    const result = await handlerFor(
      options,
      'patch',
      '/schedules/:id',
    )({
      params: { id: 's1' },
      query: {},
      body: { cron: 'bad' },
    });
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ error: { code: 'invalid_request' } });
  });

  it('maps an update-time unknown task to 404 task_not_found', async () => {
    const options = makeOptions({
      schedules: schedulesApi({
        retrieve: async () => queueSchedule(),
        update: async () => {
          throw new UnknownTaskError('ghost');
        },
      }),
    });
    const result = await handlerFor(
      options,
      'patch',
      '/schedules/:id',
    )({
      params: { id: 's1' },
      query: {},
      body: { task: 'ghost' },
    });
    expect(result.status).toBe(404);
    expect(result.body).toMatchObject({ error: { code: 'task_not_found' } });
  });

  it('maps an UnsupportedCapabilityError from runNow to 501 unsupported_capability', async () => {
    const options = makeOptions({
      schedules: schedulesApi({
        retrieve: async () => queueSchedule(),
        runNow: async () => {
          throw new UnsupportedCapabilityError('delay', 'stub-transport');
        },
      }),
    });
    const result = await handlerFor(
      options,
      'post',
      '/schedules/:id/run',
    )({ params: { id: 's1' }, query: {} });
    expect(result.status).toBe(501);
    const parsed = errorResponseSchema.parse(result.body);
    expect(parsed.error.code).toBe('unsupported_capability');
  });
});

describe('control app auth', () => {
  it('serves /health without a token', async () => {
    const app = buildControlApp(makeOptions({ token: 'secret' }));
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('rejects /catalog without a token', async () => {
    const app = buildControlApp(makeOptions({ token: 'secret' }));
    const res = await app.request('/catalog');
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  });

  it('accepts /catalog with a valid token', async () => {
    const app = buildControlApp(makeOptions({ token: 'secret' }));
    const res = await app.request('/catalog', {
      headers: { Authorization: 'Bearer secret' },
    });
    expect(res.status).toBe(200);
  });

  it('emits a 401 body matching the wire error envelope', async () => {
    const app = buildControlApp(makeOptions({ token: 'secret' }));
    const res = await app.request('/catalog');
    expect(res.status).toBe(401);
    const parsed = errorResponseSchema.parse(await res.json());
    expect(parsed.error.code).toBe('unauthorized');
    expect(parsed.error.message.length).toBeGreaterThan(0);
  });

  it('builds on a runtime without a process global (edge/serverless safe)', () => {
    // The /control entry targets edge/serverless where `process` may be absent;
    // reading NODE_ENV must not throw a ReferenceError before the app exists.
    vi.stubGlobal('process', undefined);
    try {
      expect(() =>
        buildControlApp(makeOptions({ token: 'secret' })),
      ).not.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('fails closed on an edge runtime with no process and no configured auth', async () => {
    // No `process` (edge) + no api.token/api.auth: an unreadable environment
    // cannot be assumed non-production, so the control API must lock rather than
    // fall open. The policy is baked when the app is built, so build under the
    // stub, then restore `process` before issuing the request.
    vi.stubGlobal('process', undefined);
    try {
      const app = buildControlApp(makeOptions());
      vi.unstubAllGlobals();
      const res = await app.request('/catalog');
      expect(res.status).toBe(401);
      const parsed = errorResponseSchema.parse(await res.json());
      expect(parsed.error.code).toBe('unauthorized');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('control query round-trip', () => {
  it('reconstructs run list options from the client-serialized query', async () => {
    let capturedUrl = '';
    const client = createClient({
      host: 'http://control.test',
      fetch: async (input) => {
        capturedUrl = typeof input === 'string' ? input : input.toString();
        return new Response(JSON.stringify({ data: [], hasMore: false }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    await client.runs.list({
      task: 'send-email',
      status: 'completed',
      meta: { tags: ['a'] },
      timeRange: {
        start: new Date('2026-01-01T00:00:00.000Z'),
        end: new Date('2026-01-02T00:00:00.000Z'),
      },
      sort: { field: 'createdAt', direction: 'desc' },
      limit: 10,
    });

    const query: Record<string, string> = {};
    for (const [key, value] of new URL(capturedUrl).searchParams) {
      query[key] = value;
    }

    const parsed = toRunListOptions(query);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.options).toMatchObject({
      task: 'send-email',
      status: 'completed',
      meta: { tags: ['a'] },
      sort: { field: 'createdAt', direction: 'desc' },
      limit: 10,
    });
    expect(parsed.options.timeRange?.start.toISOString()).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(parsed.options.timeRange?.end.toISOString()).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });
});

function principal(tenantId?: string): Principal {
  const base: Principal = {
    authenticator: 'api-key',
    principalId: 'api-key',
    principalType: 'service',
    attributes: {},
  };
  if (tenantId !== undefined) base.tenantId = tenantId;
  return base;
}

function ownerStamp(tenantId: string) {
  return {
    authenticator: 'api-key',
    principalId: 'api-key',
    principalType: 'service',
    tenantId,
  };
}

describe('control routes — principal stamping', () => {
  it('stamps meta.enqueuedBy from the verified principal on POST /jobs', async () => {
    let captured: EnqueueOptions | undefined;
    const options = makeOptions({
      trigger: async (_task, _input, opts) => {
        captured = opts;
        return enqueueResult;
      },
    });
    await handlerFor(
      options,
      'post',
      '/jobs',
    )({
      params: {},
      query: {},
      body: { task: 'send-email', input: {} },
      principal: principal('t1'),
    });
    expect(captured?.meta?.enqueuedBy).toEqual(ownerStamp('t1'));
  });

  it('strips an inbound enqueuedBy and re-stamps the verified principal', async () => {
    let captured: EnqueueOptions | undefined;
    const options = makeOptions({
      trigger: async (_task, _input, opts) => {
        captured = opts;
        return enqueueResult;
      },
    });
    await handlerFor(
      options,
      'post',
      '/jobs',
    )({
      params: {},
      query: {},
      body: {
        task: 'send-email',
        input: {},
        options: {
          meta: {
            enqueuedBy: {
              authenticator: 'spoof',
              principalId: 'evil',
              principalType: 'service',
              tenantId: 'other',
            },
          },
        },
      },
      principal: principal('t1'),
    });
    expect(captured?.meta?.enqueuedBy).toEqual(ownerStamp('t1'));
  });

  it('stamps meta.enqueuedBy on schedule creation', async () => {
    let captured: CreateQueueScheduleOptions | undefined;
    const options = makeOptions({
      schedules: schedulesApi({
        create: async (input) => {
          captured = input;
          return queueSchedule();
        },
      }),
    });
    await handlerFor(
      options,
      'post',
      '/schedules',
    )({
      params: {},
      query: {},
      body: { task: 'send-email', cron: '* * * * *', deduplicationKey: 'dk' },
      principal: principal('t1'),
    });
    expect(captured?.meta?.enqueuedBy).toEqual(ownerStamp('t1'));
  });

  it('scopes the deduplication key under the tenant so cross-tenant upsert is impossible', async () => {
    let captured: CreateQueueScheduleOptions | undefined;
    const options = makeOptions({
      schedules: schedulesApi({
        create: async (input) => {
          captured = input;
          return queueSchedule();
        },
      }),
    });
    await handlerFor(
      options,
      'post',
      '/schedules',
    )({
      params: {},
      query: {},
      body: {
        task: 'send-email',
        cron: '* * * * *',
        deduplicationKey: 'nightly',
      },
      principal: principal('t1'),
    });
    expect(captured?.deduplicationKey).toBe('t.t1.nightly');
  });

  it('leaves the deduplication key raw for an unscoped (operator) principal', async () => {
    let captured: CreateQueueScheduleOptions | undefined;
    const options = makeOptions({
      schedules: schedulesApi({
        create: async (input) => {
          captured = input;
          return queueSchedule();
        },
      }),
    });
    await handlerFor(
      options,
      'post',
      '/schedules',
    )({
      params: {},
      query: {},
      body: {
        task: 'send-email',
        cron: '* * * * *',
        deduplicationKey: 'nightly',
      },
      principal: principal(),
    });
    expect(captured?.deduplicationKey).toBe('nightly');
  });

  it('is idempotent across read-modify-write: a resent echoed key neither double-scopes nor creates a second schedule', async () => {
    // A dedupe-aware upsert store, mirroring the real schedule stores.
    const byId = new Map<string, QueueSchedule>();
    const byDedupe = new Map<string, string>();
    let seq = 0;
    const store = schedulesApi({
      create: async (input) => {
        const existingId = input.deduplicationKey
          ? byDedupe.get(input.deduplicationKey)
          : undefined;
        if (!existingId) seq += 1;
        const id = existingId ?? `s${seq}`;
        const schedule = queueSchedule({
          id,
          deduplicationKey: input.deduplicationKey,
          meta: input.meta ?? {},
        });
        byId.set(id, schedule);
        if (input.deduplicationKey) byDedupe.set(input.deduplicationKey, id);
        return schedule;
      },
      retrieve: async (id) => {
        const schedule = byId.get(id);
        if (!schedule) throw new Error(`Unknown queue schedule "${id}"`);
        return schedule;
      },
      update: async (id, input) => {
        const current = byId.get(id);
        if (!current) throw new Error(`Unknown queue schedule "${id}"`);
        const schedule = queueSchedule({
          id,
          deduplicationKey: input.deduplicationKey ?? current.deduplicationKey,
          meta: input.meta ?? current.meta,
        });
        byId.set(id, schedule);
        if (schedule.deduplicationKey) {
          byDedupe.set(schedule.deduplicationKey, id);
        }
        return schedule;
      },
    });
    const options = makeOptions({ schedules: store });

    // 1) Create with the raw key; the wire echoes the tenant-scoped key.
    const created = await handlerFor(
      options,
      'post',
      '/schedules',
    )({
      params: {},
      query: {},
      body: {
        task: 'send-email',
        cron: '* * * * *',
        deduplicationKey: 'nightly',
      },
      principal: principal('t1'),
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: 's1',
      deduplicationKey: 't.t1.nightly',
    });

    // 2) Read-modify-write PATCH resending the echoed key must not double-scope.
    const patched = await handlerFor(
      options,
      'patch',
      '/schedules/:id',
    )({
      params: { id: 's1' },
      query: {},
      body: { deduplicationKey: 't.t1.nightly' },
      principal: principal('t1'),
    });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ deduplicationKey: 't.t1.nightly' });

    // 3) Re-create with the echoed key upserts the SAME schedule, not a second.
    const recreated = await handlerFor(
      options,
      'post',
      '/schedules',
    )({
      params: {},
      query: {},
      body: {
        task: 'send-email',
        cron: '* * * * *',
        deduplicationKey: 't.t1.nightly',
      },
      principal: principal('t1'),
    });
    expect(recreated.body).toMatchObject({
      id: 's1',
      deduplicationKey: 't.t1.nightly',
    });
    expect(byId.size).toBe(1);
    expect(byDedupe.size).toBe(1);
  });
});

describe('control routes — ownership', () => {
  it('returns 403 forbidden when a tenant reads another tenant run', async () => {
    const options = makeOptions({
      runs: runsApi({
        retrieve: async () =>
          queueRun({ meta: { enqueuedBy: ownerStamp('t1') } }),
      }),
    });
    const result = await handlerFor(
      options,
      'get',
      '/runs/:id',
    )({ params: { id: 'r1' }, query: {}, principal: principal('t2') });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('allows a tenant to read its own run', async () => {
    const options = makeOptions({
      runs: runsApi({
        retrieve: async () =>
          queueRun({ meta: { enqueuedBy: ownerStamp('t1') } }),
      }),
    });
    const result = await handlerFor(
      options,
      'get',
      '/runs/:id',
    )({ params: { id: 'r1' }, query: {}, principal: principal('t1') });
    expect(result.status).toBe(200);
  });

  it('returns 403 when a tenant cancels another tenant run', async () => {
    let canceled = false;
    const options = makeOptions({
      runs: runsApi({
        retrieve: async () =>
          queueRun({ meta: { enqueuedBy: ownerStamp('t1') } }),
        cancel: async () => {
          canceled = true;
          return { outcome: 'not_found' };
        },
      }),
    });
    const result = await handlerFor(
      options,
      'post',
      '/runs/:id/cancel',
    )({ params: { id: 'r1' }, query: {}, principal: principal('t2') });
    expect(result.status).toBe(403);
    expect(canceled).toBe(false);
  });

  it('returns 403 when a tenant reads another tenant schedule', async () => {
    const options = makeOptions({
      schedules: schedulesApi({
        retrieve: async () =>
          queueSchedule({ meta: { enqueuedBy: ownerStamp('t1') } }),
      }),
    });
    const result = await handlerFor(
      options,
      'get',
      '/schedules/:id',
    )({ params: { id: 's1' }, query: {}, principal: principal('t2') });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('denies unowned resources to tenant-scoped callers', async () => {
    const options = makeOptions({
      runs: runsApi({ retrieve: async () => queueRun({ meta: {} }) }),
    });
    const result = await handlerFor(
      options,
      'get',
      '/runs/:id',
    )({ params: { id: 'r1' }, query: {}, principal: principal('t1') });
    expect(result.status).toBe(403);
  });
});

describe('control routes — list scoping', () => {
  it('forces the caller tenantId into the run list meta filter', async () => {
    let captured: QueueRunListOptions | undefined;
    const options = makeOptions({
      runs: runsApi({
        list: async (o) => {
          captured = o;
          return { data: [], hasMore: false };
        },
      }),
    });
    await handlerFor(
      options,
      'get',
      '/runs',
    )({
      params: {},
      // caller tries to widen to another tenant
      query: { meta: JSON.stringify({ enqueuedBy: { tenantId: 't2' } }) },
      principal: principal('t1'),
    });
    expect(captured?.meta).toEqual({ enqueuedBy: { tenantId: 't1' } });
  });

  it('leaves the filter unscoped for a super-principal', async () => {
    let captured: QueueRunListOptions | undefined;
    const options = makeOptions({
      runs: runsApi({
        list: async (o) => {
          captured = o;
          return { data: [], hasMore: false };
        },
      }),
    });
    await handlerFor(
      options,
      'get',
      '/runs',
    )({ params: {}, query: {}, principal: principal() });
    expect(captured?.meta).toBeUndefined();
  });
});

describe('control routes — PATCH ownership', () => {
  it('preserves the original owner stamp and keeps other meta fields', async () => {
    let captured: UpdateQueueScheduleOptions | undefined;
    const options = makeOptions({
      schedules: schedulesApi({
        retrieve: async () =>
          queueSchedule({ meta: { enqueuedBy: ownerStamp('t1') } }),
        update: async (_id, input) => {
          captured = input;
          return queueSchedule({ meta: { enqueuedBy: ownerStamp('t1') } });
        },
      }),
    });
    const result = await handlerFor(
      options,
      'patch',
      '/schedules/:id',
    )({
      params: { id: 's1' },
      query: {},
      body: {
        meta: {
          tags: ['x'],
          enqueuedBy: {
            authenticator: 'spoof',
            principalId: 'evil',
            principalType: 'service',
            tenantId: 't2',
          },
        },
      },
      principal: principal('t1'),
    });
    expect(result.status).toBe(200);
    expect(captured?.meta?.enqueuedBy).toEqual(ownerStamp('t1'));
    expect(captured?.meta?.tags).toEqual(['x']);
  });
});

describe('control routes — invalid query', () => {
  const cases: [string, Record<string, string>][] = [
    ['status=typo', { status: 'typo' }],
    ['sort=bogus', { sort: 'bogus' }],
    ['meta={', { meta: '{' }],
    ['lone start', { start: '2026-01-01T00:00:00.000Z' }],
    ['limit=0', { limit: '0' }],
  ];
  it.each(
    cases,
  )('returns 400 invalid_request for %s', async (_label, query) => {
    const result = await handlerFor(
      makeOptions(),
      'get',
      '/runs',
    )({ params: {}, query });
    expect(result.status).toBe(400);
    const parsed = errorResponseSchema.parse(result.body);
    expect(parsed.error.code).toBe('invalid_request');
    expect(parsed.error.issues?.length).toBeGreaterThan(0);
  });
});
