import type { Redis } from 'ioredis';
import { type NamespaceOptions, resolveNamespace } from './namespace';
import {
  createQueueSchedulesWithTransport,
  type QueueScheduleController,
} from './schedules';
import { createBullmqTransport } from './transport/bullmq';
import type {
  EnqueueOptions,
  EnqueueResult,
  QueueCatalogEntry,
  QueueState,
  TaskDefinition,
} from './types';

interface CreateQueueSchedulesOptions extends NamespaceOptions {
  redis: Redis;
  storage: QueueState;
  resolveTask(id: string): Promise<QueueCatalogEntry>;
  trigger<I>(
    target: string | TaskDefinition<I, unknown>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
}

// BullMQ-backed schedule controller: owns a Redis-derived transport and closes
// it on close(). Split out of schedules.ts so the transport-agnostic scheduler
// (createQueueSchedulesWithTransport) stays import-clean for the
// @openqueue/core/control bundle graph. Line comment, not JSDoc, so the moved
// function's emitted d.ts stays byte-identical to its pre-split form.
export function createQueueSchedules({
  redis,
  storage,
  resolveTask,
  trigger,
  ...namespaceOptions
}: CreateQueueSchedulesOptions): QueueScheduleController {
  const namespace = resolveNamespace(namespaceOptions);
  const transport = createBullmqTransport({ producer: redis, ...namespace });
  const controller = createQueueSchedulesWithTransport({
    transport,
    storage,
    resolveTask,
    trigger,
    ...namespace,
  });
  return { ...controller, close: () => transport.close() };
}
