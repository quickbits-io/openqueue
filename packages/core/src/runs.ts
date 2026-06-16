import type { QueueRunStore, QueueRunsApi, RunStatus } from './types';

const defaultPollIntervalMs = 1000;
const defaultPollMaxAttempts = 500;
const terminalRunStatuses = new Set<RunStatus>([
  'completed',
  'failed',
  'canceled',
  'timed_out',
  'expired',
]);

export function createRunsApi(store: QueueRunStore): QueueRunsApi {
  const runs: QueueRunsApi = {
    list: (options) => store.list(options),
    retrieve: async (id) => {
      const result = await store.list({ id, limit: 1 });
      return result.data[0];
    },
    poll: async (id, options) => {
      const maxAttempts = options?.maxAttempts ?? defaultPollMaxAttempts;
      for (let attempts = 0; attempts++ < maxAttempts; ) {
        const run = await runs.retrieve(id);
        if (run && isTerminalStatus(run.status)) return run;
        await sleep(options?.pollIntervalMs ?? defaultPollIntervalMs);
      }
      throw new Error(
        `Run ${id} did not complete after ${maxAttempts} attempts`,
      );
    },
  };

  return runs;
}

function isTerminalStatus(status: RunStatus): boolean {
  return terminalRunStatuses.has(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
