import { describe, expect, it } from 'vitest';
import { memoryQueueStorage } from '../store/memory';
import type { QueueRunSnapshot } from '../types';

/**
 * The in-memory run cache (world-local's store) must not grow one entry per run
 * forever — it mirrors the Redis state store's bounded cache. This guards the
 * ceiling and the newest-wins eviction order.
 */
function snapshot(over: Partial<QueueRunSnapshot> = {}): QueueRunSnapshot {
  return {
    id: over.id ?? 'run',
    name: 'echo',
    queue: 'default',
    status: 'completed',
    input: { hi: true },
    meta: {},
    metadata: {},
    tags: [],
    attempt: 1,
    maxAttempts: 1,
    willRetry: false,
    createdAt: new Date(),
    ...over,
  };
}

describe('store — memory run cache stays bounded', () => {
  it('retains at most the cache ceiling and evicts the oldest runs', async () => {
    const storage = memoryQueueStorage();
    const total = 12_000;
    for (let i = 0; i < total; i++) {
      await storage.handle({
        type: 'complete',
        run: snapshot({ id: `run-${i}` }),
      });
    }

    // list() pages at ≤500; walk the cursor to count everything retained.
    let count = 0;
    let cursor: string | undefined;
    do {
      const page = await storage.runs.list({ limit: 500, cursor });
      count += page.data.length;
      cursor = page.cursor;
    } while (cursor);

    expect(count).toBeLessThanOrEqual(5000);
    // Newest survive, oldest are evicted.
    const newest = await storage.runs.list({ id: `run-${total - 1}` });
    expect(newest.data[0]?.id).toBe(`run-${total - 1}`);
    const oldest = await storage.runs.list({ id: 'run-0' });
    expect(oldest.data).toHaveLength(0);
  });
});
