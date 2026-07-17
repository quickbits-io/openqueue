import type { QueueRunSnapshot, TaskDefinition } from '@openqueue/core/types';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
// Source-relative: createEnqueuer is the package-private instance enqueue engine
// (not a frozen export); the module-global `configureEnqueue` was removed at 1.0.
import { createEnqueuer } from '../../../core/src/enqueuer';
import { createBullmqTransport } from '../transport';

const bullmq = vi.hoisted(() => {
  type FlowNode = {
    name: string;
    queueName: string;
    data: unknown;
    opts: { jobId?: string };
    children?: FlowNode[];
  };

  class FlowProducerMock {
    flows: FlowNode[] = [];
    opts: unknown[] = [];

    constructor() {
      instances.push(this);
    }

    async add(flow: FlowNode, opts: unknown) {
      this.flows.push(flow);
      this.opts.push(opts);
      return toJobNode(flow);
    }
  }

  function toJobNode(node: FlowNode): unknown {
    return {
      job: {
        id: node.opts.jobId,
        name: node.name,
        queueName: node.queueName,
        data: node.data,
        opts: node.opts,
        timestamp: 1,
        attemptsMade: 0,
      },
      children: node.children?.map(toJobNode),
    };
  }

  const instances: FlowProducerMock[] = [];

  return { FlowProducerMock, instances };
});

vi.mock('bullmq', () => ({
  FlowProducer: bullmq.FlowProducerMock,
}));

function job<I>(input: {
  name: string;
  queue: string;
  schema?: z.ZodType<I>;
}): TaskDefinition<I, unknown> {
  return {
    id: input.name,
    name: input.name,
    queue: input.queue,
    schema: input.schema,
    handler: async () => undefined,
    concurrency: 1,
    attempts: 2,
    backoff: { type: 'fixed', delay: 1 },
    tags: [],
  };
}

describe('enqueueFlow', () => {
  it('adds wrapped flow jobs with dependency options and enqueue hooks', async () => {
    const parent = job({
      name: 'process-bank-transactions',
      queue: 'banking',
      schema: z.object({ tenantId: z.string() }),
    });
    const child = job({
      name: 'sync-bank-account',
      queue: 'banking',
      schema: z.object({ id: z.string(), tenantId: z.string() }),
    });
    const runs: QueueRunSnapshot[] = [];

    const enqueuer = createEnqueuer({
      transport: createBullmqTransport({ producer: {} as unknown as Redis }),
      drain: {
        handle: async (event) => {
          if (event.type === 'enqueue') runs.push(event.run);
        },
      },
    });

    const result = await enqueuer.enqueueFlow({
      def: parent,
      input: { tenantId: 'tenant-1' },
      opts: {
        jobId: 'root-job',
        meta: { tenantId: 'tenant-1', tags: ['bank-sync'] },
      },
      children: [
        {
          def: child,
          input: { id: 'acct-1', tenantId: 'tenant-1' },
          opts: {
            jobId: 'child-job',
            failParentOnFailure: true,
            meta: { tenantId: 'tenant-1', tags: ['bank-sync'] },
          },
        },
      ],
    });

    const producer = bullmq.instances[0]!;
    const flow = producer.flows[0]!;
    const flowOpts = producer.opts[0] as {
      queuesOptions: Record<string, { defaultJobOptions: unknown }>;
    };

    expect(result).toMatchObject({
      id: 'root-job',
      runId: 'root-job',
      jobId: 'root-job',
      transportJobId: 'root-job',
    });
    expect(flow.children?.[0]?.opts).toMatchObject({
      jobId: 'child-job',
      failParentOnFailure: true,
    });
    expect(flowOpts.queuesOptions.banking?.defaultJobOptions).toMatchObject({
      removeOnComplete: { count: 20_000 },
      removeOnFail: { count: 5_000 },
    });
    expect(flow.data).toMatchObject({
      __input: { tenantId: 'tenant-1' },
      __runId: 'root-job',
      __meta: {
        tenantId: 'tenant-1',
        tags: expect.arrayContaining(['bank-sync', 'run:root-job']),
      },
      __metadata: {},
    });
    expect(flow.children?.[0]?.data).toMatchObject({
      __runId: 'child-job',
      __meta: {
        tenantId: 'tenant-1',
        parentRunId: 'root-job',
        tags: expect.arrayContaining(['bank-sync', 'run:child-job']),
      },
    });
    expect(runs.map((run) => [run.id, run.status, run.parentRunId])).toEqual([
      ['root-job', 'waiting_children', undefined],
      ['child-job', 'queued', 'root-job'],
    ]);

    await expect(
      enqueuer.enqueueFlow({
        def: parent,
        input: { tenantId: 1 },
        opts: { jobId: 'invalid-input' },
        children: [],
      }),
    ).rejects.toThrow();
    await expect(
      enqueuer.enqueueFlow({
        def: parent,
        input: { tenantId: 'tenant-1' },
        opts: { jobId: 'invalid:job' },
        children: [],
      }),
    ).rejects.toThrow('Flow job ids cannot contain ":"');
  });
});
