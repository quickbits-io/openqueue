import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { clientErrorFrom, startTestWorker, type TestWorker } from '../harness';
import { queueRuns } from '../queue-schema';

let w: TestWorker;

beforeAll(async () => {
  w = await startTestWorker();
});

afterAll(async () => {
  await w.close();
});

const pollFast = { pollIntervalMs: 50, maxAttempts: 400 };

test('GET /health is public (no auth) and returns { ok: true }', async () => {
  const res = await fetch(`${w.url}/openqueue/v1/health`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('GET /info is auth-gated: bare fetch → 401 envelope + WWW-Authenticate', async () => {
  const res = await fetch(`${w.url}/openqueue/v1/info`);
  expect(res.status).toBe(401);
  expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  expect(await res.json()).toMatchObject({ error: { code: 'unauthorized' } });
});

test('client.info() returns the worker identity', async () => {
  expect(await w.client.info()).toEqual({
    service: 'openqueue',
    apiVersion: 1,
    namespace: w.namespace,
    tasks: 1,
    queues: ['e2e'],
  });
});

test('catalog contains the echo task', async () => {
  const catalog = await w.client.catalog.read();
  expect(catalog).toContainEqual(
    expect.objectContaining({ id: 'echo', queue: 'e2e' }),
  );
});

test('enqueue → poll → completed output, and the run is persisted to Postgres', async () => {
  const { runId } = await w.client.trigger('echo', { value: 'hi' });
  const run = await w.client.runs.poll(runId, pollFast);
  expect(run.status).toBe('completed');
  expect(run.output).toEqual({ echoed: 'hi' });

  // Postgres proof: the run is read Postgres-first, so a completed poll means
  // the row is durably written — not just cached in Redis.
  const rows = await w.db
    .select()
    .from(queueRuns)
    .where(eq(queueRuns.id, runId));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe('completed');
});

test('malformed enqueue → 400 invalid_request with an issue on `task`', async () => {
  const res = await fetch(`${w.url}/openqueue/v1/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${w.token}`,
    },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.error.code).toBe('invalid_request');
  expect(body.error.issues).toEqual(
    expect.arrayContaining([expect.objectContaining({ path: 'task' })]),
  );
});

test('unknown task raw → 404 task_not_found', async () => {
  const res = await fetch(`${w.url}/openqueue/v1/jobs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${w.token}`,
    },
    body: JSON.stringify({ task: 'missing', input: {} }),
  });
  expect(res.status).toBe(404);
  expect(await res.json()).toMatchObject({ error: { code: 'task_not_found' } });
});

test('unknown task via client → rejects OpenQueueClientError code not_found', async () => {
  const error = await clientErrorFrom(w.client.trigger('missing', {}));
  expect(error.code).toBe('not_found');
});

test('cancel a delayed run → canceled, then the run reads back canceled', async () => {
  const { runId } = await w.client.trigger(
    'echo',
    { value: 'later' },
    { delay: 60_000 },
  );
  const result = await w.client.runs.cancel(runId);
  expect(result.outcome).toBe('canceled');
  const run = await w.client.runs.retrieve(runId);
  expect(run?.status).toBe('canceled');
});

test('cancel a completed run → already_finished', async () => {
  const { runId } = await w.client.trigger('echo', { value: 'done' });
  await w.client.runs.poll(runId, pollFast);
  const result = await w.client.runs.cancel(runId);
  expect(result.outcome).toBe('already_finished');
});

test('cancel an unknown run id → not_found', async () => {
  const result = await w.client.runs.cancel('does-not-exist');
  expect(result.outcome).toBe('not_found');
});

test('runs.list filtered by task includes the runs created above', async () => {
  const { runId } = await w.client.trigger('echo', { value: 'listed' });
  await w.client.runs.poll(runId, pollFast);
  const result = await w.client.runs.list({ task: 'echo', limit: 50 });
  expect(result.data.some((run) => run.id === runId)).toBe(true);
});

// Regression pin for the h3 migration: rou3 delivers path params raw, so the
// worker must `decodeURIComponent` them to match Hono. A custom `jobId` becomes
// the runId (enqueuer: `runId = opts.runId ?? opts.jobId ?? uuid`), and the
// client percent-encodes `GET /runs/<encodeURIComponent(id)>`. A space (→ %20)
// must decode back to the stored runId, or `retrieve` misses.
test('a custom jobId containing a space is retrievable via the percent-encoded path', async () => {
  const jobId = `e2e space ${randomUUID()}`;
  const { runId } = await w.client.trigger(
    'echo',
    { value: 'spaced' },
    { jobId, delay: 60_000 },
  );
  expect(runId).toBe(jobId);
  const run = await w.client.runs.retrieve(runId);
  expect(run?.id).toBe(jobId);
});
