import { describe, expect, it, vi } from 'vitest';
import { createClient } from '../client';
import { OpenQueueClientError } from '../errors';

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler: (req: Recorded) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body: unknown =
      init?.body != null ? JSON.parse(String(init.body)) : undefined;
    const recorded: Recorded = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body,
    };
    calls.push(recorded);
    return handler(recorded);
  };
  return { fetch, calls };
}

function firstCall(calls: Recorded[]): Recorded {
  const call = calls[0];
  if (!call) throw new Error('expected a recorded request');
  return call;
}

function wireRunPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    task: 'send-email',
    queue: 'default',
    status: 'completed',
    input: {},
    meta: {},
    metadata: {},
    tags: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function wireSchedulePayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    type: 'IMPERATIVE',
    task: 'send-email',
    active: true,
    cron: '* * * * *',
    timezone: 'UTC',
    meta: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('createClient auth', () => {
  it('sends a bearer token from a static string', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = createClient({
      host: 'http://control.test',
      auth: { bearer: 'secret' },
      fetch,
    });

    await client.health();

    const call = firstCall(calls);
    expect(call.headers.get('authorization')).toBe('Bearer secret');
    expect(call.url).toBe('http://control.test/openqueue/v1/health');
  });

  it('resolves the bearer token per request', async () => {
    let n = 0;
    const bearer = vi.fn(async () => `tok-${++n}`);
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = createClient({
      host: 'http://control.test',
      auth: { bearer },
      fetch,
    });

    await client.health();
    await client.health();

    expect(bearer).toHaveBeenCalledTimes(2);
    expect(calls[0]?.headers.get('authorization')).toBe('Bearer tok-1');
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer tok-2');
  });

  it('sends a Basic auth header for basic credentials', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = createClient({
      host: 'http://control.test',
      auth: { basic: { username: 'admin', password: 'pw' } },
      fetch,
    });

    await client.health();

    expect(firstCall(calls).headers.get('authorization')).toBe(
      `Basic ${btoa('admin:pw')}`,
    );
  });
});

describe('createClient trigger', () => {
  it('triggers a task by id with the enqueue body shape', async () => {
    const result = { id: 'r1', runId: 'r1', jobId: 'j1', transportJobId: 'j1' };
    const { fetch, calls } = stubFetch(() => jsonResponse(result, 201));
    const client = createClient({ host: 'http://x', fetch });

    await expect(
      client.trigger('send-email', { to: 'a@b.com' }, { delay: 5 }),
    ).resolves.toEqual(result);

    const call = firstCall(calls);
    expect(call.method).toBe('POST');
    expect(call.url).toBe('http://x/openqueue/v1/jobs');
    expect(call.body).toEqual({
      task: 'send-email',
      input: { to: 'a@b.com' },
      options: { delay: 5 },
    });
  });

  it('parses input locally when triggering a TaskRef with a schema', async () => {
    const result = { id: 'r1', runId: 'r1', jobId: 'j1', transportJobId: 'j1' };
    const { fetch, calls } = stubFetch(() => jsonResponse(result, 201));
    const client = createClient({ host: 'http://x', fetch });
    const parse = vi.fn((_input: unknown): unknown => ({ clean: true }));

    await client.trigger({ id: 'task-x', schema: { parse } }, { raw: 1 });

    expect(parse).toHaveBeenCalledWith({ raw: 1 });
    expect(firstCall(calls).body).toMatchObject({
      task: 'task-x',
      input: { clean: true },
    });
  });
});

describe('createClient runs', () => {
  it('returns undefined when a run is not found', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ error: { code: 'run_not_found', message: 'nope' } }, 404),
    );
    const client = createClient({ host: 'http://x', fetch });

    await expect(client.runs.retrieve('missing')).resolves.toBeUndefined();
  });

  it('hydrates run dates on retrieve', async () => {
    const { fetch } = stubFetch(() => jsonResponse(wireRunPayload()));
    const client = createClient({ host: 'http://x', fetch });

    const run = await client.runs.retrieve('r1');
    expect(run?.createdAt).toBeInstanceOf(Date);
    expect(run?.updatedAt).toBeInstanceOf(Date);
    expect(run?.status).toBe('completed');
  });

  it('round-trips meta.enqueuedBy through the run wire schema', async () => {
    const enqueuedBy = {
      authenticator: 'api-key',
      principalId: 'api-key',
      principalType: 'service',
      tenantId: 't1',
    };
    const { fetch } = stubFetch(() =>
      jsonResponse(wireRunPayload({ meta: { enqueuedBy } })),
    );
    const client = createClient({ host: 'http://x', fetch });

    const run = await client.runs.retrieve('r1');
    expect(run?.meta.enqueuedBy).toEqual(enqueuedBy);
  });

  it('polls until the run reaches a terminal status', async () => {
    const statuses = ['executing', 'executing', 'completed'];
    let i = 0;
    const { fetch } = stubFetch(() =>
      jsonResponse(wireRunPayload({ status: statuses[i++] ?? 'completed' })),
    );
    const client = createClient({ host: 'http://x', fetch });

    const run = await client.runs.poll('r1', {
      pollIntervalMs: 0,
      maxAttempts: 5,
    });
    expect(run.status).toBe('completed');
    expect(i).toBe(3);
  });

  it('serializes run list query params', async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse({ data: [], hasMore: false }),
    );
    const client = createClient({ host: 'http://x', fetch });

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

    const url = new URL(firstCall(calls).url);
    expect(url.searchParams.get('task')).toBe('send-email');
    expect(url.searchParams.get('status')).toBe('completed');
    expect(url.searchParams.get('meta')).toBe(JSON.stringify({ tags: ['a'] }));
    expect(url.searchParams.get('start')).toBe('2026-01-01T00:00:00.000Z');
    expect(url.searchParams.get('end')).toBe('2026-01-02T00:00:00.000Z');
    expect(url.searchParams.get('sort')).toBe('createdAt:desc');
    expect(url.searchParams.get('limit')).toBe('10');
  });

  it('maps a 200 cancel response to outcome canceled', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        { outcome: 'canceled', run: wireRunPayload({ status: 'canceled' }) },
        200,
      ),
    );
    const client = createClient({ host: 'http://x', fetch });

    const result = await client.runs.cancel('r1');
    expect(result.outcome).toBe('canceled');
    if (result.outcome === 'canceled') {
      expect(result.run.status).toBe('canceled');
    }
  });

  it('maps a 409 cancel response to its outcome', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        {
          outcome: 'not_cancelable',
          run: wireRunPayload({ status: 'executing' }),
          reason: 'executing',
        },
        409,
      ),
    );
    const client = createClient({ host: 'http://x', fetch });

    const result = await client.runs.cancel('r1');
    expect(result).toMatchObject({
      outcome: 'not_cancelable',
      reason: 'executing',
    });
  });

  it('maps a 404 cancel response to not_found', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ error: { code: 'run_not_found', message: 'x' } }, 404),
    );
    const client = createClient({ host: 'http://x', fetch });

    await expect(client.runs.cancel('missing')).resolves.toEqual({
      outcome: 'not_found',
    });
  });
});

describe('createClient schedules', () => {
  it('creates a schedule via POST /schedules', async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse(wireSchedulePayload(), 201),
    );
    const client = createClient({ host: 'http://x', fetch });

    const schedule = await client.schedules.create({
      task: 'send-email',
      cron: '* * * * *',
      deduplicationKey: 'dk',
    });

    const call = firstCall(calls);
    expect(call.method).toBe('POST');
    expect(call.url).toBe('http://x/openqueue/v1/schedules');
    expect(call.body).toMatchObject({
      task: 'send-email',
      cron: '* * * * *',
      deduplicationKey: 'dk',
    });
    expect(schedule.createdAt).toBeInstanceOf(Date);
  });

  it('updates a schedule via PATCH', async () => {
    const { fetch, calls } = stubFetch(() =>
      jsonResponse(wireSchedulePayload()),
    );
    const client = createClient({ host: 'http://x', fetch });

    await client.schedules.update('s1', { cron: '0 * * * *' });

    const call = firstCall(calls);
    expect(call.method).toBe('PATCH');
    expect(call.url).toBe('http://x/openqueue/v1/schedules/s1');
    expect(call.body).toEqual({ cron: '0 * * * *' });
  });

  it('deletes a schedule and returns the boolean flag', async () => {
    const { fetch, calls } = stubFetch(() => jsonResponse({ deleted: true }));
    const client = createClient({ host: 'http://x', fetch });

    await expect(client.schedules.delete('s1')).resolves.toBe(true);
    expect(firstCall(calls).method).toBe('DELETE');
  });

  it('returns false when deleting a missing schedule', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse(
        { error: { code: 'schedule_not_found', message: 'x' } },
        404,
      ),
    );
    const client = createClient({ host: 'http://x', fetch });

    await expect(client.schedules.delete('missing')).resolves.toBe(false);
  });
});

describe('createClient error mapping', () => {
  it('maps a 401 to an unauthorized client error', async () => {
    const { fetch } = stubFetch(() =>
      jsonResponse({ error: { code: 'unauthorized', message: 'no' } }, 401),
    );
    const client = createClient({ host: 'http://x', fetch });

    const error = await client.runs.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenQueueClientError);
    if (error instanceof OpenQueueClientError) {
      expect(error.code).toBe('unauthorized');
      expect(error.status).toBe(401);
    }
  });

  it('maps a fetch rejection to a network error', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new Error('boom');
    };
    const client = createClient({ host: 'http://x', fetch });

    const error = await client.health().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenQueueClientError);
    if (error instanceof OpenQueueClientError) {
      expect(error.code).toBe('network_error');
    }
  });

  it('maps a malformed success body to invalid_response', async () => {
    const { fetch } = stubFetch(() => jsonResponse({ nonsense: true }));
    const client = createClient({ host: 'http://x', fetch });

    const error = await client.runs.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenQueueClientError);
    if (error instanceof OpenQueueClientError) {
      expect(error.code).toBe('invalid_response');
    }
  });

  it('maps a 500 to a server error carrying status and raw details', async () => {
    const body = { error: { code: 'internal', message: 'boom' } };
    const { fetch } = stubFetch(() => jsonResponse(body, 500));
    const client = createClient({ host: 'http://x', fetch });

    const error = await client.runs.list().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenQueueClientError);
    if (error instanceof OpenQueueClientError) {
      expect(error.code).toBe('server_error');
      expect(error.status).toBe(500);
      expect(error.message).toBe('boom');
      expect(error.details).toEqual(body);
    }
  });
});
