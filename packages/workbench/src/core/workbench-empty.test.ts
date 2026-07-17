import { describe, expect, it } from 'vitest';
import { buildRouteTable } from '../api/handlers';
import type {
  WorkbenchJobDefinition,
  WorkbenchRegistry,
  WorkbenchSchedulesStorage,
} from './types';
import { WorkbenchCore } from './workbench';

/**
 * Stage C lets a worker mount the Workbench over a non-BullMQ world: no queues,
 * but a live registry (test enqueue) and dynamic schedules. `queues: []` is now
 * an explicit, valid state — the BullMQ-scoped pages degrade to empty rather
 * than the core refusing to construct.
 */

function job(): WorkbenchJobDefinition {
  return {
    name: 'ping',
    queue: 'system',
    description: 'Ping.',
    handler: null,
    concurrency: 1,
    attempts: 1,
    backoff: { type: 'fixed', delay: 0 },
    tags: [],
  };
}

const schedules: WorkbenchSchedulesStorage = {
  list: async () => [],
  retrieve: async (id) => {
    throw new Error(`no schedule ${id}`);
  },
  runNow: async (id) => ({ id }),
  activate: async (id) => {
    throw new Error(`no schedule ${id}`);
  },
  deactivate: async (id) => {
    throw new Error(`no schedule ${id}`);
  },
  delete: async () => false,
};

function emptyCore(registry: WorkbenchRegistry): WorkbenchCore {
  return new WorkbenchCore({
    queues: [],
    registry,
    queue: { schedules },
    alerts: { enabled: false },
  });
}

function route(core: WorkbenchCore, method: 'get' | 'post', path: string) {
  const entry = buildRouteTable(core).find(
    (candidate) => candidate.method === method && candidate.path === path,
  );
  if (!entry) throw new Error(`route ${method} ${path} not found`);
  return entry;
}

describe('WorkbenchCore with an explicit empty queue set', () => {
  it('constructs, and getConfig reflects zero queues with a live registry', () => {
    const core = emptyCore({
      jobs: [job()],
      enqueueJob: async () => ({ id: 'run-1' }),
      enqueueFlow: async () => ({ id: 'flow-1' }),
    });

    const config = core.getConfig();
    expect(config.queues).toEqual([]);
    expect(config.capabilities.dynamicSchedules).toBe(true);
    expect(config.registry.jobs.map((entry) => entry.id)).toEqual([
      'system/ping',
    ]);
  });

  it('serves /queues as an empty list', async () => {
    const core = emptyCore({
      jobs: [job()],
      enqueueJob: async () => ({ id: 'run-1' }),
      enqueueFlow: async () => ({ id: 'flow-1' }),
    });

    const response = await route(core, 'get', '/queues').handler({
      params: {},
      query: {},
      body: undefined,
    });
    expect(response).toEqual({ status: 200, body: [] });
  });

  it('serves /overview with zeroed counts', async () => {
    const core = emptyCore({
      jobs: [job()],
      enqueueJob: async () => ({ id: 'run-1' }),
      enqueueFlow: async () => ({ id: 'flow-1' }),
    });

    const response = await route(core, 'get', '/overview').handler({
      params: {},
      query: {},
      body: undefined,
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      totalJobs: 0,
      activeJobs: 0,
      failedJobs: 0,
      queues: [],
    });
  });

  it('delegates /test to the registry enqueue callback', async () => {
    const calls: Array<{ input: unknown }> = [];
    const core = emptyCore({
      jobs: [job()],
      enqueueJob: async (_entry, input) => {
        calls.push({ input });
        return { id: 'run-1' };
      },
      enqueueFlow: async () => ({ id: 'flow-1' }),
    });

    const response = await route(core, 'post', '/test').handler({
      params: {},
      query: {},
      body: { type: 'job', id: 'system/ping', data: { hello: 'world' } },
    });

    expect(response).toEqual({
      status: 200,
      body: { id: 'run-1', type: 'job', name: 'ping', queueName: 'system' },
    });
    expect(calls).toEqual([{ input: { hello: 'world' } }]);
  });

  it('still throws when neither queues nor redis is provided', () => {
    expect(() => new WorkbenchCore({})).toThrow(/requires at least one queue/);
  });
});
