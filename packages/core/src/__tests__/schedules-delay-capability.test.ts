import { describe, expect, it } from 'vitest';
import { createQueueSchedulesWithTransport } from '../schedules';
import {
  type QueueTransport,
  type TransportCapabilities,
  UnsupportedCapabilityError,
} from '../transport/types';
import type { QueueCatalogEntry } from '../types';
import { memoryStorage } from './support/memory-storage';

/**
 * A world without `delay` support cannot run schedules. The controller must
 * reject a create/update/activate *before* touching the store, so a failed
 * request leaves no orphan schedule behind.
 */
const noDelayCapabilities: TransportCapabilities = {
  delay: false,
  priority: false,
  flows: false,
  deduplication: false,
  remove: false,
};

function noDelayTransport(): QueueTransport {
  return {
    id: 'no-delay',
    capabilities: noDelayCapabilities,
    enqueue: async (_queue, spec) => ({ jobId: spec.id }),
    enqueueFlow: async () => ({ jobId: 'x' }),
    getJob: async () => undefined,
    listDelayed: async () => [],
    consume: () => ({ close: async () => undefined }),
    close: async () => undefined,
  };
}

const catalogEntry: QueueCatalogEntry = {
  id: 'report',
  name: 'report',
  queue: 'default',
  attempts: 1,
  backoff: { type: 'fixed', delay: 1 },
  concurrency: 1,
  tags: [],
  updatedAt: new Date().toISOString(),
  version: new Date().toISOString(),
};

describe('schedule controller — delay capability', () => {
  it('rejects create and persists no schedule on a world without delay', async () => {
    const storage = memoryStorage();
    const controller = createQueueSchedulesWithTransport({
      transport: noDelayTransport(),
      storage,
      resolveTask: async () => catalogEntry,
      trigger: async () => ({ runId: 'r', jobId: 'j' }),
    });

    await expect(
      controller.create({
        task: 'report',
        cron: '0 * * * *',
        deduplicationKey: 'report-hourly',
      }),
    ).rejects.toBeInstanceOf(UnsupportedCapabilityError);

    expect(await storage.schedules.list({})).toEqual([]);
  });
});
