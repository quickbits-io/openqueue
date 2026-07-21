import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { memoryQueueStorage } from '../store/memory';
import type { QueueRunSnapshot } from '../types';

/**
 * A duplicate enqueue of a retained job is a no-op — the transport dedups the
 * add and no worker callback follows — yet the enqueuer still emits an enqueue
 * snapshot. The store must not let that `queued` snapshot resurrect a run that
 * already reached a terminal state.
 */
function snapshot(over: Partial<QueueRunSnapshot> = {}): QueueRunSnapshot {
  return {
    id: over.id ?? `run-${randomUUID()}`,
    name: 'echo',
    queue: 'default',
    status: 'completed',
    input: { hi: true },
    output: { echoed: true },
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

describe('store — enqueue never resurrects a terminal run', () => {
  it('keeps a completed run completed on a duplicate enqueue', async () => {
    const storage = memoryQueueStorage();
    const run = snapshot({ status: 'completed' });

    await storage.handle({ type: 'complete', run });
    await storage.handle({
      type: 'enqueue',
      run: snapshot({ id: run.id, status: 'queued', output: undefined }),
    });

    const listed = await storage.runs.list({ id: run.id });
    expect(listed.data[0]?.status).toBe('completed');
  });

  it('still records the first enqueue of a fresh run', async () => {
    const storage = memoryQueueStorage();
    const run = snapshot({ status: 'queued', output: undefined });

    await storage.handle({ type: 'enqueue', run });

    const listed = await storage.runs.list({ id: run.id });
    expect(listed.data[0]?.status).toBe('queued');
  });
});
