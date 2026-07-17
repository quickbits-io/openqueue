import type { Queue } from 'bullmq';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { buildRouteTable } from '../api/handlers';
import { QueueManager } from './queue-manager';
import type {
  WorkbenchFlowTemplate,
  WorkbenchJobDefinition,
  WorkbenchRegistry,
} from './types';
import { WorkbenchCore } from './workbench';

const jobSchema = z.object({ message: z.string() });

function queue(name: string): Queue {
  return {
    name,
    opts: {},
  } as unknown as Queue;
}

function job(): WorkbenchJobDefinition {
  return {
    name: 'send-message',
    queue: 'system',
    schema: jobSchema,
    description: 'Send a message.',
    handler: async () => undefined,
    concurrency: 1,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    tags: ['manual'],
  };
}

function flow(): WorkbenchFlowTemplate {
  return {
    id: 'message-flow',
    name: 'Message flow',
    queue: 'system',
    description: 'Send a message flow.',
    schema: jobSchema,
    build: (input) => ({ flow: input }),
  };
}

function enqueueResult(id: string) {
  return {
    id,
    runId: id,
    jobId: id,
    transportJobId: id,
  };
}

function core(input: { readonly?: boolean; registry: WorkbenchRegistry }) {
  return new WorkbenchCore({
    queues: [queue('system')],
    readonly: input.readonly,
    alerts: { enabled: false },
    registry: input.registry,
  });
}

function testRoute(workbench: WorkbenchCore) {
  const route = buildRouteTable(workbench).find(
    (entry) => entry.method === 'post' && entry.path === '/test',
  );
  if (!route) throw new Error('test route not found');
  return route;
}

describe('QueueManager registry', () => {
  test('returns serializable jobs and flows without handlers or schemas', () => {
    const registry: WorkbenchRegistry = {
      jobs: [job()],
      flows: [flow()],
      enqueueJob: async () => enqueueResult('job-1'),
      enqueueFlow: async () => enqueueResult('flow-1'),
    };

    const config = new QueueManager([], [], registry).getRegistryConfig();

    expect(config.jobs).toEqual([
      {
        type: 'job',
        id: 'system/send-message',
        name: 'send-message',
        queue: 'system',
        description: 'Send a message.',
        attempts: 3,
        cron: undefined,
        tags: ['manual'],
      },
    ]);
    expect(config.flows).toEqual([
      {
        type: 'flow',
        id: 'message-flow',
        name: 'Message flow',
        queue: 'system',
        description: 'Send a message flow.',
        tags: [],
      },
    ]);
    expect('handler' in config.jobs[0]!).toBe(false);
    expect('schema' in config.jobs[0]!).toBe(false);
    expect('build' in config.flows[0]!).toBe(false);
    expect('schema' in config.flows[0]!).toBe(false);
  });

  test('test route rejects readonly mode', async () => {
    const route = testRoute(
      core({
        readonly: true,
        registry: {
          jobs: [job()],
          flows: [flow()],
          enqueueJob: async () => enqueueResult('job-1'),
          enqueueFlow: async () => enqueueResult('flow-1'),
        },
      }),
    );

    await expect(
      route.handler({
        params: {},
        query: {},
        body: { type: 'job', id: 'system/send-message', data: {} },
      }),
    ).resolves.toEqual({
      status: 403,
      body: { error: 'Dashboard is in readonly mode' },
    });
  });

  test('test route rejects unknown ids and invalid payloads', async () => {
    const registry: WorkbenchRegistry = {
      jobs: [job()],
      flows: [flow()],
      enqueueJob: async (entry, input) => {
        entry.schema?.parse(input);
        return enqueueResult('job-1');
      },
      enqueueFlow: async () => enqueueResult('flow-1'),
    };
    const route = testRoute(core({ registry }));

    const unknown = await route.handler({
      params: {},
      query: {},
      body: { type: 'job', id: 'system/missing', data: { message: 'Hello' } },
    });
    expect(unknown).toEqual({
      status: 400,
      body: { error: 'Unknown job "system/missing"', issues: undefined },
    });

    const unknownFlow = await route.handler({
      params: {},
      query: {},
      body: { type: 'flow', id: 'missing-flow', data: { message: 'Hello' } },
    });
    expect(unknownFlow).toEqual({
      status: 400,
      body: { error: 'Unknown flow "missing-flow"', issues: undefined },
    });

    const invalid = await route.handler({
      params: {},
      query: {},
      body: { type: 'job', id: 'system/send-message', data: {} },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body).toEqual({
      error: 'Invalid payload',
      issues: [
        {
          path: 'message',
          message: 'Invalid input: expected string, received undefined',
        },
      ],
    });
  });

  test('test route enqueues valid jobs and flows through registry callbacks', async () => {
    const calls: unknown[] = [];
    const registry: WorkbenchRegistry = {
      jobs: [job()],
      flows: [flow()],
      enqueueJob: async (entry, input, opts) => {
        entry.schema?.parse(input);
        calls.push({ type: 'job', input, opts });
        return enqueueResult('job-1');
      },
      enqueueFlow: async (spec) => {
        calls.push({ type: 'flow', spec });
        return enqueueResult('flow-1');
      },
    };
    const route = testRoute(core({ registry }));

    await expect(
      route.handler({
        params: {},
        query: {},
        body: {
          type: 'job',
          id: 'system/send-message',
          data: { message: 'Hello' },
          opts: { delay: 1000 },
        },
      }),
    ).resolves.toEqual({
      status: 200,
      body: {
        id: 'job-1',
        type: 'job',
        name: 'send-message',
        queueName: 'system',
      },
    });

    await expect(
      route.handler({
        params: {},
        query: {},
        body: {
          type: 'flow',
          id: 'message-flow',
          data: { message: 'Hello flow' },
          opts: { delay: 2000 },
        },
      }),
    ).resolves.toEqual({
      status: 200,
      body: {
        id: 'flow-1',
        type: 'flow',
        name: 'Message flow',
        queueName: 'system',
      },
    });

    expect(calls).toEqual([
      {
        type: 'job',
        input: { message: 'Hello' },
        opts: { delay: 1000 },
      },
      {
        type: 'flow',
        spec: {
          flow: { message: 'Hello flow' },
          opts: { delay: 2000 },
        },
      },
    ]);
  });
});
