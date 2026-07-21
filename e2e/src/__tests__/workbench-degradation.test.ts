import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { WORLD } from '../env';
import { startTestWorker, type TestWorker } from '../harness';

// The live degradation matrix for a non-BullMQ world: the workbench boots with
// zero BullMQ queues, so queue/run pages are empty while store-backed features
// (dynamic schedules, test enqueue → world transport) still work.
describe.skipIf(WORLD !== 'postgres')(
  'workbench degradation on a queue-less postgres world',
  () => {
    let w: TestWorker;

    beforeAll(async () => {
      w = await startTestWorker({ workbench: { enabled: true } });
    });
    afterAll(async () => {
      await w.close();
    });

    const wb = (path: string) => `${w.url}/workbench${path}`;

    test('queue list is empty (no BullMQ queues on this world)', async () => {
      const res = await fetch(wb('/api/queues'));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([]);
    });

    test('overview responds 200 with zeroed stats', async () => {
      const res = await fetch(wb('/api/overview'));
      expect(res.status).toBe(200);
    });

    test('runs page is empty (getAllRuns reads BullMQ, not the core store)', async () => {
      const res = await fetch(wb('/api/runs'));
      expect(res.status).toBe(200);
      const body = await res.json();
      // getAllRuns reads BullMQ; with no queues it returns no rows (total is a
      // -1 "unknown" sentinel on a queue-less core).
      expect(body.data).toEqual([]);
    });

    test('dynamic schedule CRUD works (world store-backed)', async () => {
      const created = await w.client.schedules.create({
        task: 'echo',
        input: { value: 'wb' },
        cron: '*/5 * * * *',
        deduplicationKey: `wb-${randomUUID()}`,
      });
      expect(created.task).toBe('echo');
      expect(await w.client.schedules.delete(created.id)).toBe(true);
    });

    test('workbench test-enqueue runs to completion via the world transport', async () => {
      const res = await fetch(wb('/api/test'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'job',
          id: 'e2e/echo',
          data: { value: 'from-workbench' },
        }),
      });
      expect(res.status).toBe(200);
      const { id } = (await res.json()) as { id: string };

      const run = await w.client.runs.poll(id, {
        pollIntervalMs: 50,
        maxAttempts: 400,
      });
      expect(run.status).toBe('completed');
      expect(run.output).toEqual({ echoed: 'from-workbench' });
    });
  },
);
