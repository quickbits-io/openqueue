import { describe, expect, it } from 'vitest';
import { formatQueueMetrics, readQueueMetrics } from './metrics';

describe('worker metrics', () => {
  it('formats per-queue Prometheus counts and aggregate scale depth', () => {
    const text = formatQueueMetrics([
      {
        queue: 'documents',
        counts: {
          waiting: 4,
          prioritized: 2,
          active: 1,
          delayed: 9,
          failed: 3,
        },
      },
      {
        queue: 'embeddings',
        counts: {
          waiting: 1,
          prioritized: 0,
          active: 2,
          delayed: 20,
          failed: 0,
        },
      },
    ]);

    expect(text).toContain(
      'openqueue_worker_queue_jobs{queue="documents",status="waiting"} 4',
    );
    expect(text).toContain(
      'openqueue_worker_queue_jobs{queue="embeddings",status="delayed"} 20',
    );
    expect(text).toContain('openqueue_worker_queue_scale_depth 7');
  });

  it('normalizes missing BullMQ counts to zero', async () => {
    const snapshot = await readQueueMetrics({
      name: 'inbox',
      getJobCounts: async () => ({ waiting: 2 }),
    });

    expect(snapshot).toEqual({
      queue: 'inbox',
      counts: {
        waiting: 2,
        prioritized: 0,
        active: 0,
        delayed: 0,
        failed: 0,
      },
    });
  });
});
