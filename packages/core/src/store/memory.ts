import { memoryQueueCatalogStore } from '../catalog';
import type {
  AlertContactPoint,
  AlertRule,
  AlertStore,
  QueueRun,
  QueueSchedule,
  QueueScheduleCreateInput,
  QueueScheduleStore,
  QueueScheduleUpdateInput,
  QueueStorage,
} from '../types';
import { filterRuns, filterSchedules, runFromSnapshot } from './filter';

/**
 * In-memory {@link QueueStorage} mirroring the Redis state store's semantics
 * exactly (dedup-key upsert on create, field-merge patch on update, deep-meta
 * filtering, name-sorted alerts) so world-local and world-bullmq share one
 * behaviour. Not part of the public package surface; composed behind a world.
 */
export function memoryQueueStorage(): QueueStorage {
  const catalog = memoryQueueCatalogStore();
  const runs = new Map<string, QueueRun>();

  return {
    name: 'memory-storage',
    publish: catalog.publish,
    resolve: catalog.resolve,
    read: catalog.read,
    schedules: memoryScheduleStore(),
    runs: {
      list: async (options) => filterRuns([...runs.values()], options),
    },
    alerts: memoryAlertStore(),
    handle: async (event) => {
      runs.set(event.run.id, runFromSnapshot(event.run));
    },
  };
}

function memoryScheduleStore(): QueueScheduleStore {
  const schedules = new Map<string, QueueSchedule>();
  const dedupe = new Map<string, string>();

  function write(schedule: QueueSchedule): void {
    schedules.set(schedule.id, schedule);
    if (schedule.deduplicationKey) {
      dedupe.set(schedule.deduplicationKey, schedule.id);
    }
  }

  function patch(
    id: string,
    input: QueueScheduleUpdateInput & {
      active?: boolean;
      lastRunAt?: Date;
    },
  ): QueueSchedule | undefined {
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
      active: input.active ?? current.active,
      nextRun: input.nextRunAt ?? current.nextRun,
      lastRun: input.lastRunAt ?? current.lastRun,
      updatedAt: new Date(),
    };
    write(next);
    return next;
  }

  return {
    create: async (input: QueueScheduleCreateInput) => {
      const existingId = input.deduplicationKey
        ? dedupe.get(input.deduplicationKey)
        : undefined;
      if (existingId) {
        const updated = patch(existingId, input);
        if (updated) return updated;
      }

      const now = new Date();
      const schedule: QueueSchedule = {
        id: input.id,
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
        createdAt: now,
        updatedAt: now,
      };
      write(schedule);
      return schedule;
    },
    retrieve: async (id) => schedules.get(id),
    list: async (options) => filterSchedules([...schedules.values()], options),
    update: async (id, input) => patch(id, input),
    activate: async (id) => patch(id, { active: true }),
    deactivate: async (id) => patch(id, { active: false }),
    delete: async (id) => {
      const current = schedules.get(id);
      if (current?.deduplicationKey) dedupe.delete(current.deduplicationKey);
      return schedules.delete(id);
    },
    complete: async (id, lastRunAt, nextRunAt) =>
      patch(id, { lastRunAt, nextRunAt }),
  };
}

function memoryAlertStore(): AlertStore {
  const contacts = new Map<string, AlertContactPoint>();
  const rules = new Map<string, AlertRule>();

  return {
    getContactPoints: async () => [...contacts.values()].sort(sortByName),
    getContactPoint: async (id) => contacts.get(id),
    createContactPoint: async (input) => {
      const now = Date.now();
      const point: AlertContactPoint = {
        ...input,
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      contacts.set(point.id, point);
      return point;
    },
    updateContactPoint: async (id, input) => {
      const current = contacts.get(id);
      if (!current) return undefined;
      const next: AlertContactPoint = {
        ...current,
        ...input,
        updatedAt: Date.now(),
      };
      contacts.set(id, next);
      return next;
    },
    deleteContactPoint: async (id) => contacts.delete(id),
    getRules: async () => [...rules.values()].sort(sortByName),
    getRule: async (id) => rules.get(id),
    createRule: async (input) => {
      const now = Date.now();
      const rule: AlertRule = {
        ...input,
        id: crypto.randomUUID(),
        createdAt: now,
        updatedAt: now,
      };
      rules.set(rule.id, rule);
      return rule;
    },
    updateRule: async (id, input) => {
      const current = rules.get(id);
      if (!current) return undefined;
      const next: AlertRule = { ...current, ...input, updatedAt: Date.now() };
      rules.set(id, next);
      return next;
    },
    deleteRule: async (id) => rules.delete(id),
  };
}

function sortByName<T extends { name: string }>(a: T, b: T): number {
  return a.name.localeCompare(b.name);
}
