import {
  type ClientOptions,
  createClient as createHttpClient,
  type OpenQueueClient,
} from '@openqueue/client';
import { bindQueueRuntime } from '@openqueue/core';

export {
  type ClientAuth,
  type ClientErrorCode,
  type ClientOptions,
  type OpenQueueClient,
  OpenQueueClientError,
  type TokenValue,
} from '@openqueue/client';
export type {
  QueueClient,
  QueueClientOptions,
  QueueRunPollOptions,
  QueueRunsApi,
} from '@openqueue/core';
export { createQueueClient } from '@openqueue/core';

/**
 * Create an HTTP client for a deployed worker and bind it as the process task
 * runtime, so `myTask.trigger()` / `myTask.schedules.*` go over HTTP with no
 * Redis/DB connection. For an unbound client (edge, multi-target), import
 * `createClient` from '@openqueue/client' directly.
 */
export function createClient(options: ClientOptions): OpenQueueClient {
  const client = createHttpClient(options);
  bindQueueRuntime(client);
  return client;
}
