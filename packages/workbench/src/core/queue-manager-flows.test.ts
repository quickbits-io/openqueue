import { describe, expect, test } from 'bun:test';
import type { Job, Queue } from 'bullmq';
import { QueueManager } from './queue-manager';

function job(input: {
  id: string;
  name: string;
  queueName: string;
  timestamp?: number;
  state?: string;
  parentKey?: string;
  finishedOn?: number;
  processedOn?: number;
  failedReason?: string;
}): Job {
  return {
    id: input.id,
    name: input.name,
    queueName: input.queueName,
    timestamp: input.timestamp ?? 1,
    parentKey: input.parentKey,
    finishedOn: input.finishedOn,
    processedOn: input.processedOn,
    failedReason: input.failedReason,
    opts: {},
    progress: 0,
    attemptsMade: 0,
    stacktrace: [],
    returnvalue: null,
    getState: async () => input.state ?? 'completed',
  } as unknown as Job;
}

function queue(input: {
  name: string;
  counts: Record<string, number>;
  jobs: Record<string, Job[]>;
}): Queue {
  return {
    name: input.name,
    opts: { connection: {} },
    getJobCounts: async () => input.counts,
    getJobs: async (types: string | string[]) =>
      (Array.isArray(types) ? types : [types]).flatMap(
        (type) => input.jobs[type] ?? [],
      ),
  } as unknown as Queue;
}

describe('QueueManager flows', () => {
  test('discovers completed flow roots', async () => {
    const root = job({
      id: 'root-1',
      name: 'process-bank-transactions',
      queueName: 'banking',
      timestamp: 10,
      processedOn: 20,
      finishedOn: 30,
    });
    const child = job({
      id: 'child-1',
      name: 'sync-bank-account',
      queueName: 'banking',
      parentKey: 'bull:banking:root-1',
      finishedOn: 25,
    });
    const manager = new QueueManager([
      queue({
        name: 'banking',
        counts: {
          waiting: 0,
          'waiting-children': 0,
          active: 0,
          prioritized: 0,
          completed: 2,
          failed: 0,
          delayed: 0,
        },
        jobs: {
          completed: [root, child],
        },
      }),
    ]);

    Object.assign(
      manager as unknown as {
        flowProducer: {
          getFlow(input: { id: string; queueName: string }): Promise<unknown>;
        };
      },
      {
        flowProducer: {
          getFlow: async ({ id }) =>
            id === 'root-1'
              ? {
                  job: root,
                  children: [{ job: child }],
                }
              : null,
        },
      },
    );

    await expect(manager.getFlows()).resolves.toEqual([
      {
        id: 'root-1',
        name: 'process-bank-transactions',
        queueName: 'banking',
        status: 'completed',
        totalJobs: 2,
        completedJobs: 2,
        failedJobs: 0,
        timestamp: 10,
        duration: 10,
      },
    ]);
  });
});
