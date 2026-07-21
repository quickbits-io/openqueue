import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { clientErrorFrom, startTestWorker, type TestWorker } from '../harness';

let w: TestWorker;

beforeAll(async () => {
  w = await startTestWorker();
});

afterAll(async () => {
  await w.close();
});

test('schedule CRUD lifecycle: create → update → toggle → runNow → delete', async () => {
  const created = await w.client.schedules.create({
    task: 'echo',
    input: { value: 'scheduled' },
    cron: '*/5 * * * *',
    deduplicationKey: `sched-${randomUUID()}`,
  });
  expect(created.task).toBe('echo');
  expect(created.cron).toBe('*/5 * * * *');
  const id = created.id;

  const retrieved = await w.client.schedules.retrieve(id);
  expect(retrieved.id).toBe(id);

  const list = await w.client.schedules.list();
  expect(list.some((schedule) => schedule.id === id)).toBe(true);

  const updated = await w.client.schedules.update(id, { cron: '*/10 * * * *' });
  expect(updated.cron).toBe('*/10 * * * *');

  const deactivated = await w.client.schedules.deactivate(id);
  expect(deactivated.active).toBe(false);

  const activated = await w.client.schedules.activate(id);
  expect(activated.active).toBe(true);

  const { runId } = await w.client.schedules.runNow(id);
  const run = await w.client.runs.poll(runId, {
    pollIntervalMs: 50,
    maxAttempts: 400,
  });
  expect(run.status).toBe('completed');
  expect(run.output).toEqual({ echoed: 'scheduled' });

  expect(await w.client.schedules.delete(id)).toBe(true);

  const error = await clientErrorFrom(w.client.schedules.retrieve(id));
  expect(error.code).toBe('not_found');

  expect(await w.client.schedules.delete(id)).toBe(false);
});
