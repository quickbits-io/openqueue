import { describe, expect, it, vi } from 'vitest';
import { createRunCancel } from '../cancel';
import type { QueueTransport } from '../transport/types';
import { UnsupportedCapabilityError } from '../transport/types';
import type {
  QueueDrain,
  QueueDrainEvent,
  QueueRun,
  QueueRunStore,
  RunStatus,
} from '../types';

function transport(remove = true): Pick<QueueTransport, 'id' | 'capabilities'> {
  return {
    id: 'stub',
    capabilities: {
      delay: true,
      priority: true,
      flows: true,
      deduplication: true,
      remove,
    },
  };
}

function run(
  overrides: Partial<QueueRun> & { id: string; status: RunStatus },
): QueueRun {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    task: 'send-email',
    queue: 'default',
    input: {},
    meta: {},
    metadata: {},
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function store(runs: QueueRun[]): QueueRunStore {
  return {
    list: async (options) => ({
      data: runs
        .filter((r) => !options?.id || r.id === options.id)
        .slice(0, options?.limit),
      hasMore: false,
    }),
  };
}

function recordingDrain(): { drain: QueueDrain; events: QueueDrainEvent[] } {
  const events: QueueDrainEvent[] = [];
  return {
    events,
    drain: {
      handle: async (event) => {
        events.push(event);
      },
    },
  };
}

const noQueue = () => ({ getJob: async () => undefined });

describe('createRunCancel', () => {
  it('returns not_found when the run does not exist', async () => {
    const cancel = createRunCancel({
      store: store([]),
      transport: transport(),
      getQueue: noQueue,
      drain: recordingDrain().drain,
    });

    await expect(cancel('missing')).resolves.toEqual({ outcome: 'not_found' });
  });

  it('returns already_finished for a terminal run', async () => {
    const finished = run({ id: 'r1', status: 'completed' });
    const cancel = createRunCancel({
      store: store([finished]),
      transport: transport(),
      getQueue: noQueue,
      drain: recordingDrain().drain,
    });

    await expect(cancel('r1')).resolves.toEqual({
      outcome: 'already_finished',
      run: finished,
    });
  });

  it('returns not_cancelable for an executing run', async () => {
    const executing = run({ id: 'r1', status: 'executing' });
    const cancel = createRunCancel({
      store: store([executing]),
      transport: transport(),
      getQueue: noQueue,
      drain: recordingDrain().drain,
    });

    await expect(cancel('r1')).resolves.toEqual({
      outcome: 'not_cancelable',
      run: executing,
      reason: 'executing',
    });
  });

  it('cancels a queued run, removes the job, and emits a cancel event', async () => {
    const queued = run({
      id: 'r1',
      status: 'queued',
      transportJobId: 'job-1',
    });
    const { drain, events } = recordingDrain();
    const remove = vi.fn(async () => {});
    const getQueue = () => ({
      getJob: async () => ({ attemptsMade: 0, opts: { attempts: 3 }, remove }),
    });

    const result = await createRunCancel({
      store: store([queued]),
      transport: transport(),
      getQueue,
      drain,
    })('r1');

    expect(remove).toHaveBeenCalledOnce();
    expect(result.outcome).toBe('canceled');
    if (result.outcome === 'canceled') {
      expect(result.run.status).toBe('canceled');
      expect(result.run.finishedAt).toBeInstanceOf(Date);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'cancel',
      run: { id: 'r1', status: 'canceled', name: 'send-email', attempt: 1 },
    });
  });

  it('cancels when the transport job is already gone', async () => {
    const delayed = run({ id: 'r1', status: 'delayed' });
    const { drain, events } = recordingDrain();

    const result = await createRunCancel({
      store: store([delayed]),
      transport: transport(),
      getQueue: noQueue,
      drain,
    })('r1');

    expect(result.outcome).toBe('canceled');
    expect(events).toHaveLength(1);
  });

  it('returns not_cancelable when removing the job throws', async () => {
    const queued = run({ id: 'r1', status: 'queued' });
    const { drain, events } = recordingDrain();
    const getQueue = () => ({
      getJob: async () => ({
        attemptsMade: 1,
        opts: { attempts: 3 },
        remove: async () => {
          throw new Error('job is locked');
        },
      }),
    });

    const result = await createRunCancel({
      store: store([queued]),
      transport: transport(),
      getQueue,
      drain,
    })('r1');

    expect(result).toEqual({
      outcome: 'not_cancelable',
      run: queued,
      reason: 'executing',
    });
    expect(events).toHaveLength(0);
  });

  it('throws UnsupportedCapabilityError for a queued run when remove is unsupported', async () => {
    const queued = run({ id: 'r1', status: 'queued' });
    const { drain, events } = recordingDrain();
    const remove = vi.fn(async () => {});
    const getQueue = () => ({
      getJob: async () => ({ attemptsMade: 0, opts: { attempts: 3 }, remove }),
    });

    const cancel = createRunCancel({
      store: store([queued]),
      transport: transport(false),
      getQueue,
      drain,
    });

    const err = await cancel('r1').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(err).toBeInstanceOf(UnsupportedCapabilityError);
    if (err instanceof UnsupportedCapabilityError) {
      expect(err.capability).toBe('remove');
    }
    expect(remove).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('short-circuits a terminal run before the capability check', async () => {
    const finished = run({ id: 'r1', status: 'completed' });
    const cancel = createRunCancel({
      store: store([finished]),
      transport: transport(false),
      getQueue: noQueue,
      drain: recordingDrain().drain,
    });

    await expect(cancel('r1')).resolves.toEqual({
      outcome: 'already_finished',
      run: finished,
    });
  });
});
