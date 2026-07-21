import { describe, expect, it } from 'vitest';
import { configureEnqueueTransport, enqueue, enqueueFlow } from '../../enqueue';
import type { QueueDrainEvent, TaskDefinition } from '../../types';
import type {
  QueueTransport,
  TransportCapabilities,
  TransportCapability,
  TransportFlowNode,
  TransportJobSpec,
} from '../types';
import { UnsupportedCapabilityError } from '../types';

function stubTransport(caps: Partial<TransportCapabilities> = {}) {
  const enqueued: TransportJobSpec[] = [];
  const flows: TransportFlowNode[] = [];
  const transport: QueueTransport = {
    id: 'stub',
    capabilities: {
      delay: false,
      priority: false,
      flows: false,
      deduplication: false,
      remove: false,
      ...caps,
    },
    enqueue: async (_queue, spec) => {
      enqueued.push(spec);
      return { jobId: spec.id };
    },
    enqueueFlow: async (node) => {
      flows.push(node);
      return { jobId: node.spec.id };
    },
    getJob: async () => undefined,
    listDelayed: async () => [],
    consume: () => ({ close: async () => undefined }),
    close: async () => undefined,
  };
  return { transport, enqueued, flows };
}

function task(over: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: 't',
    name: 't',
    queue: 'q',
    handler: async () => undefined,
    concurrency: 1,
    attempts: 1,
    backoff: { type: 'fixed', delay: 1 },
    tags: [],
    ...over,
  };
}

function recordingDrain() {
  const events: QueueDrainEvent[] = [];
  return {
    events,
    drain: {
      handle: async (event: QueueDrainEvent) => {
        events.push(event);
      },
    },
  };
}

async function expectCapabilityError(
  promise: Promise<unknown>,
  capability: TransportCapability,
): Promise<void> {
  const err = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(err).toBeInstanceOf(UnsupportedCapabilityError);
  if (err instanceof UnsupportedCapabilityError) {
    expect(err.capability).toBe(capability);
    expect(err.message).toContain('stub');
  }
}

describe('transport capability enforcement', () => {
  it('rejects delay when the transport cannot delay, without emitting a hook', async () => {
    const { transport, enqueued } = stubTransport();
    const { drain, events } = recordingDrain();
    configureEnqueueTransport({ transport, drain });

    await expectCapabilityError(enqueue(task(), {}, { delay: 100 }), 'delay');
    expect(events).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('rejects priority when the transport cannot prioritize', async () => {
    const { transport, enqueued } = stubTransport({ delay: true });
    const { drain, events } = recordingDrain();
    configureEnqueueTransport({ transport, drain });

    await expectCapabilityError(
      enqueue(task(), {}, { priority: 5 }),
      'priority',
    );
    expect(events).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('rejects flows when the transport cannot run flows', async () => {
    const { transport, flows } = stubTransport();
    const { drain, events } = recordingDrain();
    configureEnqueueTransport({ transport, drain });

    await expectCapabilityError(
      enqueueFlow({ def: task(), input: {}, children: [] }),
      'flows',
    );
    expect(events).toHaveLength(0);
    expect(flows).toHaveLength(0);
  });

  it('emits the enqueue hook before the transport call when supported', async () => {
    const { transport } = stubTransport({ delay: true, priority: true });
    const order: string[] = [];
    const drain = {
      handle: async () => {
        order.push('hook');
      },
    };
    const wrapped: QueueTransport = {
      ...transport,
      enqueue: async (queue, spec) => {
        order.push('transport');
        return transport.enqueue(queue, spec);
      },
    };
    configureEnqueueTransport({ transport: wrapped, drain });

    await enqueue(task(), {}, { delay: 100, priority: 1 });
    expect(order).toEqual(['hook', 'transport']);
  });
});
