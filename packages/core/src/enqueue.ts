import { composeDrains } from './compose';
import { createEnqueuer, type Enqueuer } from './enqueuer';
import { bindQueueRuntime } from './task';
import type { QueueTransport } from './transport/types';
import type {
  EnqueueOptions,
  EnqueueResult,
  FlowParentSpec,
  QueueDrain,
  TaskDefinition,
} from './types';

/**
 * Process-global enqueue facade behind the public `enqueue`/`enqueueFlow` API.
 * It owns one default {@link Enqueuer} instance; the accumulate-drains contract
 * of `configureEnqueueTransport` recreates that instance so bare `enqueue()`/
 * `task.trigger()` in a single-runtime process stay identical. Runtimes compose
 * their own {@link Enqueuer} for drain isolation.
 */
let defaultEnqueuer: Enqueuer | null = null;
let sharedDrain: QueueDrain = composeDrains();

export function configureEnqueueTransport(opts: {
  transport: QueueTransport;
  drain?: QueueDrain;
  drains?: QueueDrain[];
}): void {
  sharedDrain = composeDrains(sharedDrain, opts.drain, ...(opts.drains ?? []));
  defaultEnqueuer = createEnqueuer({
    transport: opts.transport,
    drain: sharedDrain,
  });
  bindQueueRuntime({
    trigger: async (target, input, triggerOpts) => {
      if (typeof target === 'string') {
        throw new Error(
          `@openqueue/sdk: Unknown task "${target}"; worker catalog has not been published`,
        );
      }
      return enqueue(target, input, triggerOpts);
    },
  });
}

function assertEnqueuer(): Enqueuer {
  if (!defaultEnqueuer) {
    throw new Error(
      '@openqueue/sdk: enqueue() called before the transport was configured. Boot a worker or client (or bind an HTTP client) at process start.',
    );
  }
  return defaultEnqueuer;
}

export function enqueue<I, O>(
  def: TaskDefinition<I, O>,
  input: I,
  opts?: EnqueueOptions,
): Promise<EnqueueResult> {
  return assertEnqueuer().enqueue(def, input, opts);
}

export function enqueueFlow(parent: FlowParentSpec): Promise<EnqueueResult> {
  return assertEnqueuer().enqueueFlow(parent);
}
