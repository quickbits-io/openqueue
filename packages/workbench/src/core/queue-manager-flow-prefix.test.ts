import type { Queue } from 'bullmq';
import { describe, expect, test, vi } from 'vitest';
import { QueueManager } from './queue-manager';

/**
 * The worker's transport namespaces its BullMQ queues under
 * `${prefix}:${namespace}`. The Workbench builds its FlowProducer from the
 * queues it's handed, so it must inherit their prefix — otherwise flow reads
 * and creation default to `bull` and touch a different Redis keyspace than the
 * worker. Record the FlowProducer's construction options so the assertion needs
 * no live Redis.
 */
const { flowProducerOpts } = vi.hoisted(() => ({
  flowProducerOpts: [] as Array<{ prefix?: string }>,
}));

vi.mock('bullmq', async () => {
  const actual = await vi.importActual<typeof import('bullmq')>('bullmq');
  return {
    ...actual,
    FlowProducer: class {
      constructor(opts: { prefix?: string }) {
        flowProducerOpts.push(opts);
      }
      close(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

function namespacedQueue(name: string, prefix: string): Queue {
  return {
    name,
    opts: { connection: { host: '127.0.0.1', port: 6399 }, prefix },
  } as unknown as Queue;
}

describe('QueueManager FlowProducer prefix', () => {
  test('inherits the queue prefix so flows share the worker keyspace', () => {
    new QueueManager([namespacedQueue('emails', 'bull:acme')]);

    expect(flowProducerOpts).toHaveLength(1);
    expect(flowProducerOpts[0]?.prefix).toBe('bull:acme');
  });
});
