import type { BackoffOptions } from '../types';
import type {
  ActiveTransportJob,
  ConsumeOptions,
  QueueTransport,
  TransportCapabilities,
  TransportConsumer,
  TransportFlowNode,
  TransportJobHandle,
  TransportJobSpec,
} from './types';

/**
 * In-process {@link QueueTransport} — a priority-sorted backlog, `setTimeout`
 * delayed promotion, a dedup map, flow dependency counting, active-set
 * concurrency, and remove. All five capabilities are true.
 *
 * It pins the same behaviour BullMQ gives core so world-local (and, in Stage C,
 * world-postgres) inherit one contract: `attemptsMade` is 0 inside `process()`
 * and 1-based in callbacks; `onFailed` fires on every attempt with
 * `final = isFinal(err)` (non-retryable, NOT attempts-exhausted); `updateData`
 * persists across retries; a finished job leaves the map (so retention is a
 * no-op and dedup is best-effort); a failed flow parent emits no worker
 * callback.
 *
 * `spec.retention` and `maxStalledCount` are accepted and ignored;
 * `job.log()` is a no-op returning 0 (Stage C wires log capture).
 */

type LocalJobState = 'delayed' | 'waiting' | 'waiting-children' | 'active';

interface LocalJobRecord {
  id: string;
  spec: TransportJobSpec;
  queue: string;
  data: unknown;
  state: LocalJobState;
  seq: number;
  timestamp: number;
  attemptsMade: number;
  processedOn?: number;
  finishedOn?: number;
  returnvalue: unknown;
  progress: unknown;
  timer?: ReturnType<typeof setTimeout>;
  parent?: LocalJobRecord;
  pendingChildren: number;
}

interface LocalConsumer {
  options: ConsumeOptions;
  active: number;
  closed: boolean;
  inflight: Set<Promise<void>>;
}

interface LocalQueue {
  jobs: Map<string, LocalJobRecord>;
  consumers: LocalConsumer[];
}

const capabilities: TransportCapabilities = {
  delay: true,
  priority: true,
  flows: true,
  deduplication: true,
  remove: true,
};

export function createLocalTransport(): QueueTransport {
  const queues = new Map<string, LocalQueue>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let seq = 0;
  let closed = false;

  function ensureQueue(name: string): LocalQueue {
    let queue = queues.get(name);
    if (!queue) {
      queue = { jobs: new Map(), consumers: [] };
      queues.set(name, queue);
    }
    return queue;
  }

  function schedule(
    record: LocalJobRecord,
    delayMs: number,
    fn: () => void,
  ): void {
    if (closed) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      record.timer = undefined;
      fn();
    }, delayMs);
    timers.add(timer);
    record.timer = timer;
  }

  function clearRecordTimer(record: LocalJobRecord): void {
    if (record.timer) {
      clearTimeout(record.timer);
      timers.delete(record.timer);
      record.timer = undefined;
    }
  }

  function createRecord(
    queueName: string,
    spec: TransportJobSpec,
  ): LocalJobRecord {
    return {
      id: spec.id,
      spec,
      queue: queueName,
      data: spec.data,
      state: 'waiting',
      seq: seq++,
      timestamp: Date.now(),
      attemptsMade: 0,
      returnvalue: undefined,
      progress: undefined,
      pendingChildren: 0,
    };
  }

  function admit(record: LocalJobRecord): void {
    const delay = record.spec.delay ?? 0;
    if (delay > 0) {
      record.state = 'delayed';
      schedule(record, delay, () => {
        record.state = 'waiting';
        pump(record.queue);
      });
    } else {
      record.state = 'waiting';
      pump(record.queue);
    }
  }

  function activeJob(record: LocalJobRecord): ActiveTransportJob {
    return {
      id: record.id,
      name: record.spec.name,
      queueName: record.queue,
      timestamp: record.timestamp,
      opts: { attempts: record.spec.attempts, delay: record.spec.delay },
      get data() {
        return record.data;
      },
      get attemptsMade() {
        return record.attemptsMade;
      },
      get processedOn() {
        return record.processedOn;
      },
      get finishedOn() {
        return record.finishedOn;
      },
      get returnvalue() {
        return record.returnvalue;
      },
      updateData: async (data) => {
        record.data = data;
      },
      updateProgress: async (progress) => {
        record.progress = progress;
      },
      log: async () => 0,
    };
  }

  function jobHandle(record: LocalJobRecord): TransportJobHandle {
    return {
      name: record.spec.name,
      opts: { attempts: record.spec.attempts },
      get data() {
        return record.data;
      },
      get attemptsMade() {
        return record.attemptsMade;
      },
      remove: async () => removeJob(record),
    };
  }

  function nextWaiting(queue: LocalQueue): LocalJobRecord | undefined {
    let best: LocalJobRecord | undefined;
    for (const record of queue.jobs.values()) {
      if (record.state !== 'waiting') continue;
      if (!best) {
        best = record;
        continue;
      }
      const priority = record.spec.priority ?? 0;
      const bestPriority = best.spec.priority ?? 0;
      if (
        priority < bestPriority ||
        (priority === bestPriority && record.seq < best.seq)
      ) {
        best = record;
      }
    }
    return best;
  }

  function pump(queueName: string): void {
    const queue = queues.get(queueName);
    if (!queue) return;
    for (const consumer of queue.consumers) {
      if (consumer.closed) continue;
      const concurrency = consumer.options.concurrency ?? 1;
      while (consumer.active < concurrency) {
        const record = nextWaiting(queue);
        if (!record) break;
        record.state = 'active';
        consumer.active += 1;
        const promise = runAttempt(queueName, record, consumer).catch((err) => {
          consumer.options.onError(err);
        });
        consumer.inflight.add(promise);
        void promise.finally(() => consumer.inflight.delete(promise));
      }
    }
  }

  async function runCallback(
    consumer: LocalConsumer,
    fn: () => Promise<void> | void,
  ): Promise<void> {
    try {
      await fn();
    } catch (err) {
      consumer.options.onError(err);
    }
  }

  async function runAttempt(
    queueName: string,
    record: LocalJobRecord,
    consumer: LocalConsumer,
  ): Promise<void> {
    const options = consumer.options;
    const job = activeJob(record);
    if (record.processedOn === undefined) record.processedOn = Date.now();

    let ok = false;
    let value: unknown;
    let error: unknown;
    try {
      value = await options.process(job);
      ok = true;
    } catch (err) {
      error = err;
    }
    record.attemptsMade += 1;
    const queue = queues.get(queueName);

    if (ok) {
      record.returnvalue = value;
      record.finishedOn = Date.now();
      queue?.jobs.delete(record.id);
      await runCallback(consumer, () => options.onCompleted(job));
      if (record.parent) settleParentOnComplete(record);
    } else {
      const final = options.isFinal(error);
      const willRetry =
        !final && record.attemptsMade < (record.spec.attempts ?? 1);
      if (willRetry) {
        record.state = 'delayed';
        schedule(
          record,
          retryDelay(record.spec.backoff, record.attemptsMade),
          () => {
            record.state = 'waiting';
            pump(queueName);
          },
        );
      } else {
        record.finishedOn = Date.now();
        queue?.jobs.delete(record.id);
        if (record.parent) settleParentOnFinalFailure(record);
      }
      await runCallback(consumer, () =>
        options.onFailed(job, error, { final }),
      );
    }

    consumer.active -= 1;
    pump(queueName);
  }

  function promoteParent(parent: LocalJobRecord): void {
    const delay = parent.spec.delay ?? 0;
    if (delay > 0) {
      parent.state = 'delayed';
      schedule(parent, delay, () => {
        parent.state = 'waiting';
        pump(parent.queue);
      });
    } else {
      parent.state = 'waiting';
      pump(parent.queue);
    }
  }

  /** True while `parent` is still an active waiting-children node in its map. */
  function parentPending(parent: LocalJobRecord): boolean {
    const queue = queues.get(parent.queue);
    return (
      queue?.jobs.get(parent.id) === parent &&
      parent.state === 'waiting-children'
    );
  }

  function settleParentOnComplete(child: LocalJobRecord): void {
    const parent = child.parent;
    if (!parent || !parentPending(parent)) return;
    parent.pendingChildren -= 1;
    if (parent.pendingChildren <= 0) promoteParent(parent);
  }

  function settleParentOnFinalFailure(child: LocalJobRecord): void {
    const parent = child.parent;
    if (!parent || !parentPending(parent)) return;

    if (child.spec.ignoreDependencyOnFailure) {
      parent.pendingChildren -= 1;
      if (parent.pendingChildren <= 0) promoteParent(parent);
      return;
    }
    if (child.spec.failParentOnFailure) {
      failParent(parent);
      return;
    }
    if (child.spec.continueParentOnFailure) {
      promoteParent(parent);
      return;
    }
    // Default: the parent stays waiting-children indefinitely (blocked parent).
  }

  function failParent(parent: LocalJobRecord): void {
    clearRecordTimer(parent);
    queues.get(parent.queue)?.jobs.delete(parent.id);
    // Propagate upward only when the parent itself opted its own parent in — no
    // worker callback fires for a flow-failed parent (BullMQ event parity).
    if (parent.spec.failParentOnFailure && parent.parent) {
      if (parentPending(parent.parent)) failParent(parent.parent);
    }
  }

  async function removeJob(record: LocalJobRecord): Promise<void> {
    if (record.state === 'active') {
      throw new Error(
        `@openqueue/sdk: job "${record.id}" is active and cannot be removed`,
      );
    }
    clearRecordTimer(record);
    queues.get(record.queue)?.jobs.delete(record.id);
    if (record.parent) settleParentOnComplete(record);
  }

  function buildFlowRecord(
    node: TransportFlowNode,
    parent: LocalJobRecord | undefined,
  ): LocalJobRecord {
    const queue = ensureQueue(node.queue);
    const existing = queue.jobs.get(node.spec.id);
    if (existing) return existing;

    const record = createRecord(node.queue, node.spec);
    record.parent = parent;
    queue.jobs.set(record.id, record);

    const children = node.children ?? [];
    if (children.length > 0) {
      record.state = 'waiting-children';
      record.pendingChildren = children.length;
      for (const child of children) buildFlowRecord(child, record);
    } else {
      admit(record);
    }
    return record;
  }

  return {
    id: 'local',
    capabilities,
    enqueue: async (queueName, spec) => {
      const queue = ensureQueue(queueName);
      if (queue.jobs.has(spec.id)) return { jobId: spec.id };
      const record = createRecord(queueName, spec);
      queue.jobs.set(record.id, record);
      admit(record);
      return { jobId: spec.id };
    },
    enqueueFlow: async (node) => {
      const root = buildFlowRecord(node, undefined);
      return { jobId: root.id };
    },
    getJob: async (queueName, id) => {
      const record = queues.get(queueName)?.jobs.get(id);
      return record ? jobHandle(record) : undefined;
    },
    listDelayed: async (queueName) => {
      const queue = queues.get(queueName);
      if (!queue) return [];
      return [...queue.jobs.values()]
        .filter((record) => record.state === 'delayed')
        .map(jobHandle);
    },
    consume: (queueName, options): TransportConsumer => {
      const queue = ensureQueue(queueName);
      const consumer: LocalConsumer = {
        options,
        active: 0,
        closed: false,
        inflight: new Set(),
      };
      queue.consumers.push(consumer);
      pump(queueName);
      return {
        close: async () => {
          consumer.closed = true;
          const current = queues.get(queueName);
          if (current) {
            current.consumers = current.consumers.filter(
              (entry) => entry !== consumer,
            );
          }
          await Promise.allSettled([...consumer.inflight]);
        },
      };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      const draining: Array<Promise<unknown>> = [];
      for (const queue of queues.values()) {
        for (const consumer of queue.consumers) {
          consumer.closed = true;
          draining.push(Promise.allSettled([...consumer.inflight]));
        }
      }
      await Promise.all(draining);
      queues.clear();
    },
  };
}

function retryDelay(
  backoff: BackoffOptions | number | undefined,
  attemptsMade: number,
): number {
  if (backoff === undefined) return 0;
  if (typeof backoff === 'number') return backoff;
  if (backoff.type === 'fixed') return backoff.delay;
  return Math.round(backoff.delay * 2 ** (attemptsMade - 1));
}
