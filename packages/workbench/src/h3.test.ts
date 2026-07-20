import { describe, expect, it } from 'vitest';
import { createWorkbenchApp } from './h3';

describe('createWorkbenchApp', () => {
  it('honors an explicit empty queue set instead of falling back to redis discovery', async () => {
    // `queues: []` is a valid degraded (non-BullMQ) dashboard. The helper must
    // build it directly, not route it to WorkbenchCore.fromOptions — which
    // requires a `redis` connection and would otherwise throw.
    const app = await createWorkbenchApp({
      queues: [],
      alerts: { enabled: false },
    });
    const res = await app.request('/config');
    expect(res.status).toBe(200);
  });
});
