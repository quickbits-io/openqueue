import { describe, expect, it } from 'vitest';
import { createRunsApi } from '../runs';
import type {
  QueueRun,
  QueueRunListOptions,
  QueueRunStore,
  RunStatus,
} from '../types';

describe('queue runs api', () => {
  it('retrieves a run by id', async () => {
    const api = createRunsApi(
      runStore([
        run({ id: 'run-1', status: 'completed' }),
        run({ id: 'run-2', status: 'queued' }),
      ]),
    );

    await expect(api.retrieve('run-1')).resolves.toMatchObject({
      id: 'run-1',
      status: 'completed',
    });
    await expect(api.retrieve('missing')).resolves.toBeUndefined();
  });

  it('polls until the run reaches a terminal status', async () => {
    let attempts = 0;
    const api = createRunsApi({
      list: async () => ({
        data: [
          attempts++ === 0
            ? run({ id: 'run-1', status: 'executing' })
            : run({ id: 'run-1', status: 'failed' }),
        ],
        hasMore: false,
      }),
    });

    await expect(
      api.poll('run-1', { pollIntervalMs: 0, maxAttempts: 3 }),
    ).resolves.toMatchObject({
      id: 'run-1',
      status: 'failed',
    });
    expect(attempts).toBe(2);
  });

  it('throws after the configured max attempts', async () => {
    let attempts = 0;
    const api = createRunsApi({
      list: async () => {
        attempts++;
        return {
          data: [run({ id: 'run-1', status: 'executing' })],
          hasMore: false,
        };
      },
    });

    await expect(
      api.poll('run-1', { pollIntervalMs: 0, maxAttempts: 2 }),
    ).rejects.toThrow('Run run-1 did not complete after 2 attempts');
    expect(attempts).toBe(2);
  });
});

function runStore(runs: QueueRun[]): QueueRunStore {
  return {
    list: async (options?: QueueRunListOptions) => {
      const data = runs.filter((run) => !options?.id || run.id === options.id);
      return {
        data: data.slice(0, options?.limit),
        hasMore: false,
      };
    },
  };
}

function run(input: { id: string; status: RunStatus }): QueueRun {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: input.id,
    task: 'start-sandbox-session',
    queue: 'sandbox',
    status: input.status,
    input: {},
    meta: {},
    metadata: {},
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}
