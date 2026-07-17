import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createClient as createPlainClient,
  type OpenQueueClient,
} from '@openqueue/client';
import { unbindQueueRuntime } from '@openqueue/sdk';
import { createClient } from '@openqueue/sdk/client';
import { clientErrorFrom, startTestWorker, type TestWorker } from '../harness';
import { echo } from '../worker/echo';

let w: TestWorker;
let token: string;
let poller: OpenQueueClient;

beforeAll(async () => {
  w = await startTestWorker();
  if (!w.token) throw new Error('token worker expected a token');
  token = w.token;
  poller = createPlainClient({ host: w.url, auth: { bearer: token } });
  // `createQueueWorker` binds the global runtime to the in-process worker at
  // boot; the sdk client must be the last bind so `echo.trigger()` goes over
  // HTTP rather than straight to the local runtime.
  createClient({ host: w.url, auth: { bearer: token } });
});

afterAll(async () => {
  unbindQueueRuntime();
  await w.close();
});

test('echo.trigger() enqueues over HTTP via the bound sdk client', async () => {
  const result = await echo.trigger({ value: 'via-sdk' });
  expect(result.runId).toBeTruthy();
  const run = await poller.runs.poll(result.runId, {
    pollIntervalMs: 50,
    maxAttempts: 400,
  });
  expect(run.status).toBe('completed');
  expect(run.output).toEqual({ echoed: 'via-sdk' });
});

test('rebinding a wrong-token client makes echo.trigger() reject unauthorized (proves the bound path is HTTP)', async () => {
  createClient({ host: w.url, auth: { bearer: 'wrong-token' } });
  const error = await clientErrorFrom(echo.trigger({ value: 'nope' }));
  expect(error.code).toBe('unauthorized');
});
