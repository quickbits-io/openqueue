import { task as defineTask, scheduleTickJobName } from '@openqueue/core';
import type { QueueState, TaskDefinition } from '@openqueue/core/types';
import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
// Source-relative: createQueueSchedulesWithTransport is the package-private
// transport-agnostic scheduler; the BullMQ-bound `createQueueSchedules` wrapper
// was removed at 1.0.
import { createQueueSchedulesWithTransport } from '../../../core/src/schedules';
import { createBullmqTransport } from '../transport';

const bullmq = vi.hoisted(() => {
  class QueueMock {
    static instances: QueueMock[] = [];
    jobs = new Map<
      string,
      {
        name: string;
        data: unknown;
        opts: { jobId?: string };
        remove: () => Promise<void>;
      }
    >();
    adds: Array<{ name: string; data: unknown; opts: { jobId?: string } }> = [];

    constructor(
      readonly name: string,
      readonly opts: unknown,
    ) {
      QueueMock.instances.push(this);
    }

    async add(name: string, data: unknown, opts: { jobId?: string }) {
      this.adds.push({ name, data, opts });
      const id = opts.jobId ?? crypto.randomUUID();
      this.jobs.set(id, {
        name,
        data,
        opts,
        remove: async () => {
          this.jobs.delete(id);
        },
      });
      return { id, name, queueName: this.name, data, opts };
    }

    async getJob(id: string) {
      return this.jobs.get(id);
    }

    async getDelayed() {
      return [...Array.from(this.jobs.values()), undefined];
    }

    async close() {}
  }

  return { QueueMock };
});

vi.mock('bullmq', () => ({
  Queue: bullmq.QueueMock,
}));

function bullmqSchedules(
  storage: QueueState,
  resolveTask: Parameters<
    typeof createQueueSchedulesWithTransport
  >[0]['resolveTask'],
  trigger: Parameters<typeof createQueueSchedulesWithTransport>[0]['trigger'],
) {
  return createQueueSchedulesWithTransport({
    transport: createBullmqTransport({ producer: {} as unknown as Redis }),
    storage,
    resolveTask,
    trigger,
  });
}

describe('queue schedules', () => {
  beforeEach(() => {
    bullmq.QueueMock.instances.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a dynamic schedule and enqueues the next tick', async () => {
    const { memoryStorage, catalogEntry } = await import(
      './support/memory-storage'
    );
    const storage = memoryStorage();
    await storage.publish([catalogEntry('send-personal-reminder')]);

    const api = bullmqSchedules(
      storage,
      async (id) => storage.resolve(id).then((entry) => entry!),
      async () => enqueueResult('run-1'),
    );

    const schedule = await api.create({
      task: 'send-personal-reminder',
      cron: '1 12 * * *',
      timezone: 'UTC',
      externalId: 'reminder-1',
      deduplicationKey: 'reminder-1',
      meta: { customerId: 'customer-1', tenantId: 'tenant-1' },
    });

    const queue = bullmq.QueueMock.instances[0]!;
    expect(schedule).toMatchObject({
      task: 'send-personal-reminder',
      externalId: 'reminder-1',
      timezone: 'UTC',
    });
    expect(queue.name).toBe('openqueue-queue-schedules');
    expect(queue.adds[0]).toMatchObject({
      name: scheduleTickJobName,
    });
    expect(queue.adds[0]?.opts.jobId).toMatch(/^queue-schedule-/);
    expect(queue.adds[0]?.opts.jobId).not.toContain(':');
  });

  it('lists schedules with generic filters', async () => {
    const { memoryStorage, catalogEntry } = await import(
      './support/memory-storage'
    );
    const storage = memoryStorage();
    await storage.publish([
      catalogEntry('send-personal-reminder'),
      catalogEntry('sync-bank-account'),
    ]);

    const api = bullmqSchedules(
      storage,
      async (id) => storage.resolve(id).then((entry) => entry!),
      async () => enqueueResult('run-1'),
    );

    await api.create({
      task: 'send-personal-reminder',
      cron: '1 12 * * *',
      externalId: 'tenant-1',
      deduplicationKey: 'tenant-1:reminder',
      meta: { tenantId: 'tenant-1', customerId: 'customer-1' },
    });
    await api.create({
      task: 'sync-bank-account',
      cron: '5 12 * * *',
      externalId: 'tenant-2',
      deduplicationKey: 'tenant-2:sync',
      meta: { tenantId: 'tenant-2' },
    });

    await expect(
      api.list({
        externalId: 'tenant-1',
        meta: { tenantId: 'tenant-1' },
        active: true,
      }),
    ).resolves.toHaveLength(1);
    await expect(
      api.list({ task: 'sync-bank-account' }),
    ).resolves.toMatchObject([{ externalId: 'tenant-2' }]);
  });

  it('fires scheduled payloads and registers the next occurrence', async () => {
    const { memoryStorage, catalogEntry } = await import(
      './support/memory-storage'
    );
    const storage = memoryStorage();
    await storage.publish([catalogEntry('send-personal-reminder')]);
    const triggered: unknown[] = [];
    const metas: unknown[] = [];

    const api = bullmqSchedules(
      storage,
      async (id) => storage.resolve(id).then((entry) => entry!),
      async (_target, input, opts) => {
        triggered.push(input);
        metas.push(opts?.meta);
        return enqueueResult('run-1');
      },
    );

    const schedule = await api.create({
      task: 'send-personal-reminder',
      cron: '1 12 * * *',
      timezone: 'UTC',
      externalId: 'reminder-1',
      deduplicationKey: 'reminder-1',
    });

    await api.fire({
      scheduleId: schedule.id,
      scheduledAt: schedule.nextRun!.toISOString(),
    });

    const [payload] = triggered as Array<{
      scheduleId: string;
      timestamp: Date;
      externalId: string;
      upcoming: Date[];
    }>;
    expect(payload).toBeDefined();
    const updated = await storage.schedules.retrieve(schedule.id);
    const queue = bullmq.QueueMock.instances[0]!;

    expect(payload!).toMatchObject({
      scheduleId: schedule.id,
      externalId: 'reminder-1',
    });
    expect(metas[0]).toMatchObject({
      scheduleId: schedule.id,
      scheduleExternalId: 'reminder-1',
    });
    expect(payload!.timestamp).toEqual(schedule.nextRun);
    expect(payload!.upcoming).toHaveLength(10);
    expect(updated?.lastRun).toEqual(schedule.nextRun);
    expect(updated?.nextRun?.getTime()).toBeGreaterThan(
      schedule.nextRun!.getTime(),
    );
    expect(queue.adds).toHaveLength(2);
  });

  it('fires declarative schedules with schema-less default input', async () => {
    const { memoryStorage, catalogEntry } = await import(
      './support/memory-storage'
    );
    const storage = memoryStorage();
    const task = defineTask({
      id: 'sync-rates',
      queue: 'system',
      cron: '0 0,12 * * *',
      tags: ['rates'],
      run: async () => undefined,
    });
    await storage.publish([catalogEntry(task.id)]);
    const triggered: unknown[] = [];
    const metas: unknown[] = [];

    const api = bullmqSchedules(
      storage,
      async (id) => storage.resolve(id).then((entry) => entry!),
      async (_target, input, opts) => {
        triggered.push(input);
        metas.push(opts?.meta);
        return enqueueResult('run-1');
      },
    );

    const schedule = await api.upsertDeclarative(
      task as unknown as TaskDefinition,
    );
    await api.fire({
      scheduleId: schedule.id,
      scheduledAt: schedule.nextRun!.toISOString(),
    });

    expect(schedule).toMatchObject({
      id: 'sched_decl_sync-rates',
      type: 'DECLARATIVE',
      task: 'sync-rates',
      input: {},
      deduplicationKey: 'declarative:sync-rates',
    });
    expect(triggered).toEqual([{}]);
    expect(metas[0]).toMatchObject({
      scheduleId: schedule.id,
      scheduleType: 'declarative',
    });
  });

  it('fires declarative schedules with schema-derived default input', async () => {
    const { memoryStorage, catalogEntry } = await import(
      './support/memory-storage'
    );
    const storage = memoryStorage();
    const task = defineTask({
      id: 'send-message',
      queue: 'system',
      cron: '0 0,12 * * *',
      schema: z.object({ message: z.string().default('Hello') }),
      run: async () => undefined,
    });
    await storage.publish([catalogEntry(task.id)]);
    const triggered: unknown[] = [];

    const api = bullmqSchedules(
      storage,
      async (id) => storage.resolve(id).then((entry) => entry!),
      async (_target, input) => {
        triggered.push(input);
        return enqueueResult('run-1');
      },
    );

    const schedule = await api.upsertDeclarative(
      task as unknown as TaskDefinition,
    );
    await api.fire({
      scheduleId: schedule.id,
      scheduledAt: schedule.nextRun!.toISOString(),
    });

    expect(schedule.input).toEqual({ message: 'Hello' });
    expect(triggered).toEqual([{ message: 'Hello' }]);
  });

  it('rejects declarative schedules when schema defaults cannot produce input', async () => {
    const { memoryStorage, catalogEntry } = await import(
      './support/memory-storage'
    );
    const storage = memoryStorage();
    const task = defineTask({
      id: 'send-message',
      queue: 'system',
      cron: '0 0,12 * * *',
      schema: z.object({ message: z.string() }),
      run: async () => undefined,
    });
    await storage.publish([catalogEntry(task.id)]);

    const api = bullmqSchedules(
      storage,
      async (id) => storage.resolve(id).then((entry) => entry!),
      async () => enqueueResult('run-1'),
    );

    await expect(
      api.upsertDeclarative(task as unknown as TaskDefinition),
    ).rejects.toThrow(
      '@openqueue/sdk: cron task "send-message" requires schema defaults or no schema',
    );
  });
});

function enqueueResult(id: string) {
  return {
    runId: id,
    jobId: id,
  };
}
