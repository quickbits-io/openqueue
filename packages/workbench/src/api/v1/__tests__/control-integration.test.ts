import { randomUUID } from 'node:crypto';
import { createClient, OpenQueueClientError } from '@openqueue/client';
import { apiKey, createQueueWorker, task } from '@openqueue/core';
import { H3 } from 'h3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildControlApp } from '../app';

const redisUrl = process.env.REDIS_URL ?? '';
const namespace = `control-test-${randomUUID()}`;

const echo = task({
  id: 'echo',
  queue: 'control-test',
  run: async (input: { value: string }) => ({ echoed: input.value }),
});

describe.skipIf(!redisUrl)('control API integration', () => {
  let runtime: Awaited<ReturnType<typeof createQueueWorker>>;
  let client: ReturnType<typeof createClient>;
  let t1Client: ReturnType<typeof createClient>;
  let t2Client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    runtime = await createQueueWorker({
      namespace,
      redis: { url: redisUrl },
      tasks: [echo],
    });
    const controlRuntime = {
      trigger: runtime.trigger,
      runs: runtime.runs,
      schedules: runtime.schedules,
      catalog: {
        read: async () => runtime.catalog,
        resolve: async (id: string) =>
          runtime.catalog.find((entry) => entry.id === id),
      },
    };
    const app = new H3();
    app.mount(
      '/openqueue/v1',
      buildControlApp({
        runtime: controlRuntime,
        auth: { token: 't' },
        info: { namespace },
      }),
    );
    client = createClient({
      host: 'http://control.test',
      auth: { bearer: 't' },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });

    const tenantApp = new H3();
    tenantApp.mount(
      '/openqueue/v1',
      buildControlApp({
        runtime: controlRuntime,
        auth: {
          strategies: [
            apiKey({ token: 't1', principal: { tenantId: 't1' } }),
            apiKey({ token: 't2', principal: { tenantId: 't2' } }),
          ],
        },
        info: { namespace },
      }),
    );
    const tenantFetch = async (input: RequestInfo | URL, init?: RequestInit) =>
      tenantApp.fetch(new Request(input, init));
    t1Client = createClient({
      host: 'http://control.test',
      auth: { bearer: 't1' },
      fetch: tenantFetch,
    });
    t2Client = createClient({
      host: 'http://control.test',
      auth: { bearer: 't2' },
      fetch: tenantFetch,
    });
  });

  afterAll(async () => {
    await runtime?.close();
  });

  it('triggers a task and polls it to completion', async () => {
    const { runId } = await client.trigger('echo', { value: 'hello' });
    const run = await client.runs.poll(runId, {
      pollIntervalMs: 50,
      maxAttempts: 200,
    });
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ echoed: 'hello' });
  });

  it('stamps enqueuedBy and denies cross-tenant access', async () => {
    const { runId } = await t1Client.trigger('echo', { value: 'owned' });
    const run = await t1Client.runs.poll(runId, {
      pollIntervalMs: 50,
      maxAttempts: 200,
    });
    expect(run.meta.enqueuedBy).toMatchObject({
      authenticator: 'api-key',
      principalType: 'service',
      tenantId: 't1',
    });

    const denied = await t2Client.runs
      .retrieve(runId)
      .catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(OpenQueueClientError);
    if (denied instanceof OpenQueueClientError) {
      expect(denied.code).toBe('forbidden');
    }
  });

  it('scopes run lists on the Redis-cache path (deep containsMeta parity)', async () => {
    const { runId } = await t1Client.trigger('echo', { value: 'listed' });
    await t1Client.runs.poll(runId, { pollIntervalMs: 50, maxAttempts: 200 });
    const t1List = await t1Client.runs.list();
    expect(t1List.data.some((entry) => entry.id === runId)).toBe(true);
    const t2List = await t2Client.runs.list();
    expect(t2List.data.some((entry) => entry.id === runId)).toBe(false);
  });

  it('round-trips a schedule', async () => {
    const schedule = await client.schedules.create({
      task: 'echo',
      input: { value: 'sched' },
      cron: '* * * * *',
      deduplicationKey: `dk-${randomUUID()}`,
    });
    expect(schedule.task).toBe('echo');

    const list = await client.schedules.list();
    expect(list.some((entry) => entry.id === schedule.id)).toBe(true);

    const result = await client.schedules.runNow(schedule.id);
    expect(result.runId).toBeTruthy();

    const deleted = await client.schedules.delete(schedule.id);
    expect(deleted).toBe(true);
  });

  it('cancels a delayed run and reads it back as canceled', async () => {
    const { runId } = await client.trigger(
      'echo',
      { value: 'later' },
      { delay: 60_000 },
    );

    const cancel = await client.runs.cancel(runId);
    expect(cancel.outcome).toBe('canceled');

    const run = await client.runs.retrieve(runId);
    expect(run?.status).toBe('canceled');
  });
});
