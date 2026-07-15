import cronParser from 'cron-parser';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import {
  DEFAULT_NAMESPACE,
  type NamespaceOptions,
  resolveNamespace,
} from './namespace';
import { createQueue } from './queue';
import { deriveDefaultInput, task } from './task';
import type {
  EnqueueOptions,
  EnqueueResult,
  QueueCatalogEntry,
  QueueSchedule,
  QueueSchedulesApi,
  QueueState,
  ScheduledTaskPayload,
  Task,
  TaskDefinition,
  TaskDefinitionInput,
} from './types';

const baseScheduleQueueName = 'queue-schedules';
export const scheduleQueueName = scheduleQueueNameFor(DEFAULT_NAMESPACE);
export const scheduleTickJobName = 'queue.schedule.tick';

export function scheduleQueueNameFor(namespace?: string): string {
  return namespace
    ? `${queueNamePart(namespace)}-${baseScheduleQueueName}`
    : baseScheduleQueueName;
}

function queueNamePart(value: string): string {
  return value.replace(/:/g, '-');
}

interface CreateQueueSchedulesOptions extends NamespaceOptions {
  redis: Redis;
  storage: QueueState;
  resolveTask(id: string): Promise<QueueCatalogEntry>;
  trigger<I>(
    target: string | TaskDefinition<I, unknown>,
    input: I,
    opts?: EnqueueOptions,
  ): Promise<EnqueueResult>;
}

interface ScheduleTickInput {
  scheduleId: string;
  scheduledAt: string;
}

export interface QueueScheduleController extends QueueSchedulesApi {
  upsertDeclarative(task: TaskDefinition): Promise<QueueSchedule>;
  fire(input: ScheduleTickInput): Promise<void>;
  close(): Promise<void>;
}

const tickSchema = z.object({
  scheduleId: z.string(),
  scheduledAt: z.string(),
});

export function createQueueSchedules({
  redis,
  storage,
  resolveTask,
  trigger,
  ...namespaceOptions
}: CreateQueueSchedulesOptions): QueueScheduleController {
  const namespace = resolveNamespace(namespaceOptions);
  const queue = createQueue(
    scheduleQueueNameFor(namespace.namespace),
    redis,
    namespace,
  );

  async function enqueueNext(schedule: QueueSchedule): Promise<void> {
    await removeScheduleJob(schedule.id);
    if (!schedule.active || !schedule.nextRun) return;

    const scheduledAt = schedule.nextRun.toISOString();
    await queue.add(
      scheduleTickJobName,
      {
        __input: {
          scheduleId: schedule.id,
          scheduledAt,
        },
        __runId: crypto.randomUUID(),
        __meta: { ...schedule.meta, tags: ['queue:schedule'] },
        __metadata: {},
      },
      {
        jobId: scheduleJobId(schedule.id, scheduledAt),
        delay: Math.max(schedule.nextRun.getTime() - Date.now(), 0),
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: { age: 30 * 24 * 3600, count: 1000 },
      },
    );
  }

  async function removeScheduleJob(id: string): Promise<void> {
    const legacy = await queue.getJob(legacyScheduleJobId(id));
    await legacy?.remove().catch(() => undefined);

    const delayed = await queue.getDelayed(0, -1);
    await Promise.all(
      delayed.map((job) =>
        job && scheduleTickMatches(job.name, job.data, id)
          ? job.remove().catch(() => undefined)
          : undefined,
      ),
    );
  }

  async function normalizeTask(task: string | TaskDefinition): Promise<string> {
    const id = typeof task === 'string' ? task : task.id;
    await resolveTask(id);
    return id;
  }

  const api: QueueScheduleController = {
    create: async (options) => {
      assertCron(options.cron);
      const task = await normalizeTask(options.task);
      const timezone = options.timezone ?? 'UTC';
      const nextRunAt = nextScheduledTimestamp(options.cron, timezone);
      const schedule = await storage.schedules.create({
        id: `sched_${crypto.randomUUID()}`,
        task,
        type: 'IMPERATIVE',
        input: options.input,
        cron: options.cron,
        timezone,
        externalId: options.externalId,
        deduplicationKey: options.deduplicationKey,
        meta: options.meta,
        nextRunAt,
      });
      await enqueueNext(schedule);
      return schedule;
    },

    retrieve: async (id) => {
      const schedule = await storage.schedules.retrieve(id);
      if (!schedule) throw new Error(`Unknown queue schedule "${id}"`);
      return schedule;
    },

    list: (options) => storage.schedules.list(options),

    runNow: async (id) => {
      const schedule = await storage.schedules.retrieve(id);
      if (!schedule) throw new Error(`Unknown queue schedule "${id}"`);
      return trigger(schedule.task, triggerInput(schedule, new Date()), {
        meta: scheduleMeta(schedule),
      });
    },

    update: async (id, options) => {
      const current = await storage.schedules.retrieve(id);
      if (!current) throw new Error(`Unknown queue schedule "${id}"`);

      const cron = options.cron ?? current.cron;
      assertCron(cron);
      const timezone = options.timezone ?? current.timezone;
      const task = options.task ? await normalizeTask(options.task) : undefined;
      const schedule = await storage.schedules.update(id, {
        ...options,
        task,
        nextRunAt: nextScheduledTimestamp(cron, timezone),
      });
      if (!schedule) throw new Error(`Unknown queue schedule "${id}"`);
      await enqueueNext(schedule);
      return schedule;
    },

    activate: async (id) => {
      const schedule = await storage.schedules.activate(id);
      if (!schedule) throw new Error(`Unknown queue schedule "${id}"`);
      await enqueueNext(schedule);
      return schedule;
    },

    deactivate: async (id) => {
      const schedule = await storage.schedules.deactivate(id);
      if (!schedule) throw new Error(`Unknown queue schedule "${id}"`);
      await removeScheduleJob(id);
      return schedule;
    },

    delete: async (id) => {
      await removeScheduleJob(id);
      return storage.schedules.delete(id);
    },

    timezones: async () => {
      const intl = Intl as unknown as {
        supportedValuesOf?: (value: 'timeZone') => string[];
      };
      return ['UTC', ...(intl.supportedValuesOf?.('timeZone') ?? [])];
    },

    upsertDeclarative: async (task) => {
      if (!task.cron) {
        throw new Error(
          `@openqueue/sdk: task "${task.id}" cannot create a declarative schedule without cron`,
        );
      }
      assertCron(task.cron);
      const timezone = 'UTC';
      const nextRunAt = nextScheduledTimestamp(task.cron, timezone);
      const schedule = await storage.schedules.create({
        id: declarativeScheduleId(task.id),
        task: task.id,
        type: 'DECLARATIVE',
        input: declarativeInput(task),
        cron: task.cron,
        timezone,
        deduplicationKey: declarativeDeduplicationKey(task.id),
        meta: { scheduleType: 'declarative' },
        nextRunAt,
      });
      await enqueueNext(schedule);
      return schedule;
    },

    fire: async ({ scheduleId, scheduledAt }) => {
      const schedule = await storage.schedules.retrieve(scheduleId);
      if (!schedule?.active) return;

      const timestamp = new Date(scheduledAt);
      if (
        schedule.nextRun &&
        schedule.nextRun.getTime() !== timestamp.getTime()
      ) {
        return;
      }

      const nextRunAt = nextScheduledTimestamp(
        schedule.cron,
        schedule.timezone,
        timestamp,
      );

      let failed = false;
      let triggerError: unknown;
      try {
        await trigger(schedule.task, triggerInput(schedule, timestamp), {
          jobId: scheduleTargetJobId(schedule.id, scheduledAt),
          meta: scheduleMeta(schedule),
        });
      } catch (error) {
        failed = true;
        triggerError = error;
      }

      const next = await storage.schedules.complete(
        schedule.id,
        timestamp,
        nextRunAt,
      );
      if (next) await enqueueNext(next);
      if (failed) throw triggerError;
    },

    close: () => queue.close(),
  };

  return api;
}

export function scheduleTickJob(
  schedules: QueueScheduleController,
  namespaceOptions: NamespaceOptions = {},
): TaskDefinition<ScheduleTickInput, void> {
  const namespace = resolveNamespace(namespaceOptions);
  return {
    id: scheduleTickJobName,
    name: scheduleTickJobName,
    queue: scheduleQueueNameFor(namespace.namespace),
    schema: tickSchema,
    handler: async (ctx) => {
      await schedules.fire(ctx.input);
    },
    concurrency: 25,
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    tags: ['queue:schedule'],
  };
}

export function scheduledTask<O>(
  input: Omit<TaskDefinitionInput<ScheduledTaskPayload, O>, 'schema'>,
): Task<ScheduledTaskPayload, O> {
  return task({
    ...input,
    schema: z.custom<ScheduledTaskPayload>(),
  });
}

export function nextScheduledTimestamp(
  cron: string,
  timezone: string,
  from = new Date(),
): Date {
  const next = nextCronStep(cron, timezone, from);
  if (next.getTime() < Date.now()) {
    return nextCronStep(cron, timezone, new Date());
  }
  return next;
}

export function nextScheduledTimestamps(
  cron: string,
  timezone: string,
  from: Date,
  count: number,
): Date[] {
  const dates: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    cursor = nextCronStep(cron, timezone, cursor);
    dates.push(cursor);
  }
  return dates;
}

export function assertCron(cron: string): void {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Queue schedules require 5-part cron expressions');
  }
  nextCronStep(cron, 'UTC', new Date());
}

function nextCronStep(cron: string, timezone: string, from: Date): Date {
  return cronParser
    .parseExpression(cron, {
      currentDate: from,
      tz: timezone === 'UTC' ? undefined : timezone,
      utc: timezone === 'UTC',
    })
    .next()
    .toDate();
}

function legacyScheduleJobId(scheduleId: string): string {
  return `queue:schedule:${scheduleId}`;
}

function scheduleJobId(scheduleId: string, scheduledAt: string): string {
  return `queue-schedule-${jobIdPart(scheduleId)}-${jobIdPart(scheduledAt)}`;
}

function scheduleTargetJobId(scheduleId: string, scheduledAt: string): string {
  return `queue-scheduled-run-${jobIdPart(scheduleId)}-${jobIdPart(scheduledAt)}`;
}

function jobIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function scheduleTickMatches(name: string, data: unknown, scheduleId: string) {
  if (name !== scheduleTickJobName) return false;
  if (!data || typeof data !== 'object') return false;
  const input = (data as { __input?: unknown }).__input;
  return (
    Boolean(input) &&
    typeof input === 'object' &&
    (input as { scheduleId?: unknown }).scheduleId === scheduleId
  );
}

function declarativeScheduleId(taskId: string): string {
  return `sched_decl_${taskId}`;
}

function declarativeDeduplicationKey(taskId: string): string {
  return `declarative:${taskId}`;
}

function declarativeInput(task: TaskDefinition): unknown {
  const input = deriveDefaultInput(task.schema);
  if (input.available) return input.value;
  throw new Error(
    `@openqueue/sdk: cron task "${task.id}" requires schema defaults or no schema`,
  );
}

function triggerInput(schedule: QueueSchedule, timestamp: Date): unknown {
  if (schedule.type === 'DECLARATIVE') return schedule.input ?? {};
  if (schedule.input !== undefined) return schedule.input;
  return scheduledPayload(schedule, timestamp);
}

function scheduledPayload(
  schedule: QueueSchedule,
  timestamp: Date,
): ScheduledTaskPayload {
  return {
    scheduleId: schedule.id,
    type: schedule.type,
    timestamp,
    lastTimestamp: schedule.lastRun,
    externalId: schedule.externalId,
    timezone: schedule.timezone,
    upcoming: nextScheduledTimestamps(
      schedule.cron,
      schedule.timezone,
      timestamp,
      10,
    ),
  };
}

function scheduleMeta(schedule: QueueSchedule): EnqueueOptions['meta'] {
  return {
    ...schedule.meta,
    scheduleId: schedule.id,
    scheduleExternalId: schedule.externalId,
  };
}

export const schedules = {
  task: scheduledTask,
};
