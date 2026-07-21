import type { QueueCatalogEntry } from '@openqueue/core/types';

/**
 * Shared in-memory {@link QueueStorage} for tests that drive a real transport
 * but need a durable-state stub. Re-exports core's production memory store
 * (source-relative — it is package-private) so its Redis-parity semantics are
 * exercised here rather than a divergent fixture.
 */
export { memoryQueueStorage as memoryStorage } from '../../../../core/src/store/memory';

export function catalogEntry(id: string): QueueCatalogEntry {
  return {
    id,
    name: id,
    queue: 'notifications',
    attempts: 1,
    backoff: { type: 'fixed', delay: 1 },
    concurrency: 1,
    tags: [],
    updatedAt: new Date().toISOString(),
    version: new Date().toISOString(),
  };
}
