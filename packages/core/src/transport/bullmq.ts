import {
  type ConnectionOptions,
  type FlowJob,
  FlowProducer,
  type Job,
  type JobsOptions,
  Queue,
  UnrecoverableError,
  Worker,
} from 'bullmq';
import type { Redis } from 'ioredis';
import {
  bullPrefix,
  type NamespaceOptions,
  resolveNamespace,
} from '../namespace';
import { defaultJobOptions } from '../queue';
import type {
  ConsumeOptions,
  QueueTransport,
  TransportCapabilities,
  TransportConsumer,
  TransportFlowNode,
  TransportJobSpec,
} from './types';

const capabilities: TransportCapabilities = {
  delay: true,
  priority: true,
  flows: true,
  deduplication: true,
  remove: true,
};

export interface BullmqConsumer extends TransportConsumer {
  worker: Worker;
}

export interface BullmqTransport extends QueueTransport {
  readonly id: 'bullmq';
  /** Escape hatch for the bullmq-scoped workbench dashboard. */
  queue(name: string): Queue;
  consume(name: string, options: ConsumeOptions): BullmqConsumer;
}

export interface CreateBullmqTransportOptions extends NamespaceOptions {
  producer: Redis;
  /** Blocking connection for consumers; defaults to `producer`. */
  consumer?: Redis;
}

export function isBullmqTransport(
  transport: QueueTransport,
): transport is BullmqTransport {
  return transport.id === 'bullmq';
}

export function createBullmqTransport(
  options: CreateBullmqTransportOptions,
): BullmqTransport {
  const namespace = resolveNamespace(options);
  const prefix = bullPrefix(namespace);
  // ioredis clients are not structurally `ConnectionOptions`; BullMQ accepts a
  // live client here. This is the single place the coercion lives.
  const connection = options.producer as unknown as ConnectionOptions;
  const workerConnection = (options.consumer ??
    options.producer) as unknown as ConnectionOptions;

  const queues = new Map<string, Queue>();
  let flowProducer: FlowProducer | null = null;

  function queue(name: string): Queue {
    const existing = queues.get(name);
    if (existing) return existing;
    const created = new Queue(name, { connection, prefix, defaultJobOptions });
    queues.set(name, created);
    return created;
  }

  function getFlowProducer(): FlowProducer {
    if (!flowProducer) {
      flowProducer = new FlowProducer({ connection, prefix });
    }
    return flowProducer;
  }

  function toFlowJob(node: TransportFlowNode): FlowJob {
    return {
      name: node.spec.name,
      queueName: node.queue,
      data: node.spec.data,
      opts: toJobsOptions(node.spec),
      children: node.children?.map(toFlowJob),
    };
  }

  return {
    id: 'bullmq',
    capabilities,
    queue,
    enqueue: async (name, spec) => {
      const job = await queue(name).add(
        spec.name,
        spec.data,
        toJobsOptions(spec),
      );
      return { jobId: job.id ?? spec.id };
    },
    enqueueFlow: async (node) => {
      const queuesOptions = Object.fromEntries(
        Array.from(collectQueueNames(node)).map((name) => [
          name,
          { defaultJobOptions },
        ]),
      );
      const { job } = await getFlowProducer().add(toFlowJob(node), {
        queuesOptions,
      });
      return { jobId: job.id ?? '' };
    },
    getJob: async (name, id) => (await queue(name).getJob(id)) ?? undefined,
    listDelayed: (name) => queue(name).getDelayed(0, -1),
    consume: (name, options) =>
      createBullmqConsumer(name, options, workerConnection, prefix),
    close: async () => {
      await Promise.all(Array.from(queues.values()).map((q) => q.close()));
      await flowProducer?.close();
    },
  };
}

function toJobsOptions(spec: TransportJobSpec): JobsOptions & { ttl?: number } {
  return {
    jobId: spec.id,
    delay: spec.delay,
    priority: spec.priority,
    attempts: spec.attempts,
    backoff: spec.backoff,
    ttl: spec.ttl,
    failParentOnFailure: spec.failParentOnFailure,
    continueParentOnFailure: spec.continueParentOnFailure,
    ignoreDependencyOnFailure: spec.ignoreDependencyOnFailure,
    ...spec.retention,
  };
}

function collectQueueNames(
  node: TransportFlowNode,
  names = new Set<string>(),
): Set<string> {
  names.add(node.queue);
  for (const child of node.children ?? []) collectQueueNames(child, names);
  return names;
}

function createBullmqConsumer(
  name: string,
  options: ConsumeOptions,
  connection: ConnectionOptions,
  prefix: string,
): BullmqConsumer {
  const worker = new Worker(
    name,
    async (job: Job) => {
      try {
        return await options.process(job);
      } catch (err) {
        throw toFinalError(err, options.isFinal);
      }
    },
    {
      connection,
      prefix,
      ...(options.concurrency !== undefined
        ? { concurrency: options.concurrency }
        : {}),
      ...(options.maxStalledCount !== undefined
        ? { maxStalledCount: options.maxStalledCount }
        : {}),
    },
  );

  worker.on('completed', async (job) => {
    await options.onCompleted(job);
  });

  worker.on('failed', async (job, err) => {
    const final = err instanceof UnrecoverableError || options.isFinal(err);
    await options.onFailed(job, err, { final });
  });

  worker.on('error', (err) => {
    options.onError(err);
  });

  return { worker, close: () => worker.close() };
}

/**
 * BullMQ only stops retrying when a processor throws `UnrecoverableError`. Core
 * rethrows the original error, so the transport performs the conversion here —
 * keeping the retry decision and the serialized error identical to before.
 */
function toFinalError(
  err: unknown,
  isFinal: (err: unknown) => boolean,
): unknown {
  if (err instanceof UnrecoverableError) return err;
  if (isFinal(err)) {
    return new UnrecoverableError(
      err instanceof Error ? err.message : String(err ?? 'Unknown error'),
    );
  }
  return err;
}
