import { getTableConfig } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { task as defineTask } from '../task';
import type {
  QueueCatalogEntry,
  QueueRunListResult,
  QueueSchedule,
  QueueScheduleCreateInput,
  QueueScheduleListOptions,
  QueueScheduleUpdateInput,
  QueueStorage,
  TaskDefinition,
} from '../types';

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

function catalogEntry(id: string): QueueCatalogEntry {
  return {
    id,
    name: id,
    queue: 'notifications',
    attempts: 1,
    backoff: { type: 'fixed', delay: 1 },
    concurrency: 1,
    tags: [],
    updatedAt: new Date().toISOString(),
    version: new Date().toISOString(),
  };
}

function memoryStorage(): QueueStorage {
  const catalog = new Map<string, QueueCatalogEntry>();
  const schedules = new Map<string, QueueSchedule>();

  return {
    publish: async (entries) => {
      catalog.clear();
      for (const entry of entries) catalog.set(entry.id, entry);
    },
    resolve: async (id) => catalog.get(id),
    read: async () => Array.from(catalog.values()),
    runs: {
      list: async (): Promise<QueueRunListResult> => ({
        data: [],
        hasMore: false,
      }),
    },
    alerts: {
      getContactPoints: async () => [],
      getContactPoint: async () => undefined,
      createContactPoint: async (input) => ({
        ...input,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      updateContactPoint: async () => undefined,
      deleteContactPoint: async () => false,
      getRules: async () => [],
      getRule: async () => undefined,
      createRule: async (input) => ({
        ...input,
        id: crypto.randomUUID(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
      updateRule: async () => undefined,
      deleteRule: async () => false,
    },
    handle: async () => undefined,
    schedules: {
      create: async (input: QueueScheduleCreateInput) => {
        const existing = Array.from(schedules.values()).find(
          (item) => item.deduplicationKey === input.deduplicationKey,
        );
        const schedule: QueueSchedule = {
          id: existing?.id ?? input.id,
          type: input.type ?? 'IMPERATIVE',
          task: input.task,
          input: input.input,
          active: true,
          cron: input.cron,
          timezone: input.timezone,
          externalId: input.externalId,
          deduplicationKey: input.deduplicationKey,
          meta: input.meta ?? {},
          nextRun: input.nextRunAt,
          createdAt: existing?.createdAt ?? new Date(),
          updatedAt: new Date(),
        };
        schedules.set(schedule.id, schedule);
        return schedule;
      },
      retrieve: async (id: string) => schedules.get(id),
      list: async (options?: QueueScheduleListOptions) =>
        Array.from(schedules.values()).filter((schedule) => {
          if (options?.task && schedule.task !== options.task) return false;
          if (
            options?.externalId &&
            schedule.externalId !== options.externalId
          ) {
            return false;
          }
          if (options?.meta) {
            for (const [key, value] of Object.entries(options.meta)) {
              if (schedule.meta[key] !== value) return false;
            }
          }
          if (
            options?.active !== undefined &&
            schedule.active !== options.active
          ) {
            return false;
          }
          return true;
        }),
      update: async (id: string, input: QueueScheduleUpdateInput) => {
        const current = schedules.get(id);
        if (!current) return undefined;
        const next: QueueSchedule = {
          ...current,
          type: input.type ?? current.type,
          task: input.task ?? current.task,
          input: input.input ?? current.input,
          cron: input.cron ?? current.cron,
          timezone: input.timezone ?? current.timezone,
          externalId:
            input.externalId === undefined
              ? current.externalId
              : (input.externalId ?? undefined),
          deduplicationKey: input.deduplicationKey ?? current.deduplicationKey,
          meta: input.meta ?? current.meta,
          nextRun: input.nextRunAt ?? current.nextRun,
          updatedAt: new Date(),
        };
        schedules.set(id, next);
        return next;
      },
      activate: async (id: string) => {
        const current = schedules.get(id);
        if (!current) return undefined;
        const next = { ...current, active: true, updatedAt: new Date() };
        schedules.set(id, next);
        return next;
      },
      deactivate: async (id: string) => {
        const current = schedules.get(id);
        if (!current) return undefined;
        const next = { ...current, active: false, updatedAt: new Date() };
        schedules.set(id, next);
        return next;
      },
      delete: async (id: string) => schedules.delete(id),
      complete: async (id: string, lastRunAt: Date, nextRunAt: Date) => {
        const current = schedules.get(id);
        if (!current) return undefined;
        const next = {
          ...current,
          lastRun: lastRunAt,
          nextRun: nextRunAt,
          updatedAt: new Date(),
        };
        schedules.set(id, next);
        return next;
      },
    },
  };
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
    const { createQueueSchedules, scheduleTickJobName } = await import(
      '../schedules.js'
    );
    const storage = memoryStorage();
    await storage.publish([catalogEntry('send-personal-reminder')]);

    const api = createQueueSchedules({
      redis: {} as never,
      storage,
      resolveTask: async (id) => storage.resolve(id).then((entry) => entry!),
      trigger: async () => enqueueResult('run-1'),
    });

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
    const { createQueueSchedules } = await import('../schedules.js');
    const storage = memoryStorage();
    await storage.publish([
      catalogEntry('send-personal-reminder'),
      catalogEntry('sync-bank-account'),
    ]);

    const api = createQueueSchedules({
      redis: {} as never,
      storage,
      resolveTask: async (id) => storage.resolve(id).then((entry) => entry!),
      trigger: async () => enqueueResult('run-1'),
    });

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
    const { createQueueSchedules } = await import('../schedules.js');
    const storage = memoryStorage();
    await storage.publish([catalogEntry('send-personal-reminder')]);
    const triggered: unknown[] = [];
    const metas: unknown[] = [];

    const api = createQueueSchedules({
      redis: {} as never,
      storage,
      resolveTask: async (id) => storage.resolve(id).then((entry) => entry!),
      trigger: async (_target, input, opts) => {
        triggered.push(input);
        metas.push(opts?.meta);
        return enqueueResult('run-1');
      },
    });

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
    const { createQueueSchedules } = await import('../schedules.js');
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

    const api = createQueueSchedules({
      redis: {} as never,
      storage,
      resolveTask: async (id) => storage.resolve(id).then((entry) => entry!),
      trigger: async (_target, input, opts) => {
        triggered.push(input);
        metas.push(opts?.meta);
        return enqueueResult('run-1');
      },
    });

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
    const { createQueueSchedules } = await import('../schedules.js');
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

    const api = createQueueSchedules({
      redis: {} as never,
      storage,
      resolveTask: async (id) => storage.resolve(id).then((entry) => entry!),
      trigger: async (_target, input) => {
        triggered.push(input);
        return enqueueResult('run-1');
      },
    });

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
    const { createQueueSchedules } = await import('../schedules.js');
    const storage = memoryStorage();
    const task = defineTask({
      id: 'send-message',
      queue: 'system',
      cron: '0 0,12 * * *',
      schema: z.object({ message: z.string() }),
      run: async () => undefined,
    });
    await storage.publish([catalogEntry(task.id)]);

    const api = createQueueSchedules({
      redis: {} as never,
      storage,
      resolveTask: async (id) => storage.resolve(id).then((entry) => entry!),
      trigger: async () => enqueueResult('run-1'),
    });

    await expect(
      api.upsertDeclarative(task as unknown as TaskDefinition),
    ).rejects.toThrow(
      '@openqueue/sdk: cron task "send-message" requires schema defaults or no schema',
    );
  });
});

function enqueueResult(id: string) {
  return {
    id,
    runId: id,
    jobId: id,
    transportJobId: id,
  };
}

describe('queue drizzle schema', () => {
  it('creates tables under a custom Postgres schema', async () => {
    const { defineQueueSchema } = await import('../drizzle.js');
    const schema = defineQueueSchema({ schema: 'jobs' });
    const schedules = getTableConfig(schema.queueSchedules);

    expect(schedules.schema).toBe('jobs');
    expect(schedules.name).toBe('schedules');
    expect(getTableConfig(schema.queueCatalog).schema).toBe('jobs');
  });
});
