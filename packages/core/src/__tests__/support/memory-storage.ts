import type { QueueCatalogEntry } from '../../types';

/**
 * Shared in-memory {@link QueueStorage} for tests that drive a real transport
 * but need a durable-state stub. Re-exports the production memory store so its
 * Redis-parity semantics (dedup-key upsert, field-merge patch, deep-meta
 * filtering, sorted lists) are exercised here rather than a divergent fixture.
 */
export { memoryQueueStorage as memoryStorage } from '../../store/memory';

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
