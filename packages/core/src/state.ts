import type { Redis } from 'ioredis';
import {
  DEFAULT_NAMESPACE,
  type NamespaceOptions,
  redisKey,
  resolveNamespace,
} from './namespace';
import { filterRuns, filterSchedules, runFromSnapshot } from './store/filter';
import type {
  AlertContactPoint,
  AlertRule,
  AlertStore,
  QueueRun,
  QueueSchedule,
  QueueScheduleCreateInput,
  QueueScheduleListOptions,
  QueueScheduleStore,
  QueueScheduleUpdateInput,
  QueueState,
  QueueStorage,
  SerializedError,
} from './types';

interface RedisStateKeys {
  schedules: string;
  schedulesComplete: string;
  scheduleDedupe: string;
  runs: string;
  runsIndex: string;
  alertContacts: string;
  alertRules: string;
}

const defaultKeys = redisStateKeys(DEFAULT_NAMESPACE);
const maxCachedRuns = 5000;
const runCacheTtlSeconds = 7 * 24 * 3600;

function redisStateKeys(namespace: string): RedisStateKeys {
  return {
    schedules: redisKey(namespace, 'schedules'),
    schedulesComplete: redisKey(namespace, 'schedules:complete'),
    scheduleDedupe: redisKey(namespace, 'schedules:dedupe'),
    runs: redisKey(namespace, 'runs'),
    runsIndex: redisKey(namespace, 'runs:index'),
    alertContacts: redisKey(namespace, 'alerts:contacts'),
    alertRules: redisKey(namespace, 'alerts:rules'),
  };
}

export function createRedisQueueState(
  redis: Redis,
  durable?: QueueStorage,
  options: NamespaceOptions = {},
): QueueState {
  const namespace = resolveNamespace(options);
  const keys = redisStateKeys(namespace.namespace);
  return {
    name: 'redis-state',
    schedules: redisScheduleStore(redis, durable?.schedules, keys),
    runs: redisRunStore(redis, durable?.runs, keys),
    alerts: redisAlertStore(redis, durable?.alerts, keys),
    handle: async (event) => {
      await writeRun(redis, keys, runFromSnapshot(event.run));
    },
  };
}

function redisScheduleStore(
  redis: Redis,
  durable?: QueueScheduleStore,
  keys: RedisStateKeys = defaultKeys,
): QueueScheduleStore {
  return {
    create: async (input) => {
      const persisted = durable
        ? await durable.create(input)
        : await createRedisSchedule(redis, keys, input);
      await writeSchedule(redis, keys, persisted);
      return persisted;
    },

    retrieve: async (id) => {
      const schedule = await readSchedule(redis, keys, id);
      if (schedule) return schedule;
      const persisted = await durable?.retrieve(id);
      if (persisted) await writeSchedule(redis, keys, persisted);
      return persisted;
    },

    list: async (options) => {
      const complete = durable
        ? await readScheduleCacheComplete(redis, keys)
        : true;

      if (durable && !complete) {
        const persisted = await durable.list(options);
        await Promise.all(
          persisted.map((schedule) => writeSchedule(redis, keys, schedule)),
        );
        if (isFullScheduleList(options)) {
          await markScheduleCacheComplete(redis, keys);
        }
        return persisted;
      }

      const schedules = await readSchedules(redis, keys);
      if (schedules.length > 0 || complete) {
        return filterSchedules(schedules, options);
      }

      const persisted = (await durable?.list(options)) ?? [];
      await Promise.all(
        persisted.map((schedule) => writeSchedule(redis, keys, schedule)),
      );
      if (durable && isFullScheduleList(options)) {
        await markScheduleCacheComplete(redis, keys);
      }
      return persisted;
    },

    update: async (id, input) => {
      const persisted = durable
        ? await durable.update(id, input)
        : await updateRedisSchedule(redis, keys, id, input);
      if (persisted) await writeSchedule(redis, keys, persisted);
      return persisted;
    },

    activate: async (id) => {
      const persisted = durable
        ? await durable.activate(id)
        : await updateRedisSchedule(redis, keys, id, { active: true });
      if (persisted) await writeSchedule(redis, keys, persisted);
      return persisted;
    },

    deactivate: async (id) => {
      const persisted = durable
        ? await durable.deactivate(id)
        : await updateRedisSchedule(redis, keys, id, { active: false });
      if (persisted) await writeSchedule(redis, keys, persisted);
      return persisted;
    },

    delete: async (id) => {
      const schedule = await readSchedule(redis, keys, id);
      const redisDeleted = await redis.hdel(keys.schedules, id);
      if (schedule?.deduplicationKey) {
        await redis.hdel(keys.scheduleDedupe, schedule.deduplicationKey);
      }
      const durableDeleted = await durable?.delete(id);
      return Boolean(durableDeleted ?? redisDeleted > 0);
    },

    complete: async (id, lastRunAt, nextRunAt) => {
      const persisted = durable
        ? await durable.complete(id, lastRunAt, nextRunAt)
        : await updateRedisSchedule(redis, keys, id, { lastRunAt, nextRunAt });
      if (persisted) await writeSchedule(redis, keys, persisted);
      return persisted;
    },
  };
}

async function createRedisSchedule(
  redis: Redis,
  keys: RedisStateKeys,
  input: QueueScheduleCreateInput,
): Promise<QueueSchedule> {
  const existingId = input.deduplicationKey
    ? await redis.hget(keys.scheduleDedupe, input.deduplicationKey)
    : null;
  if (existingId) {
    const updated = await updateRedisSchedule(redis, keys, existingId, input);
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
  await writeSchedule(redis, keys, schedule);
  return schedule;
}

async function updateRedisSchedule(
  redis: Redis,
  keys: RedisStateKeys,
  id: string,
  input: QueueScheduleUpdateInput & {
    active?: boolean;
    lastRunAt?: Date;
  },
): Promise<QueueSchedule | undefined> {
  const current = await readSchedule(redis, keys, id);
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
  await writeSchedule(redis, keys, next);
  return next;
}

async function writeSchedule(
  redis: Redis,
  keys: RedisStateKeys,
  schedule: QueueSchedule,
): Promise<void> {
  await redis.hset(
    keys.schedules,
    schedule.id,
    JSON.stringify(scheduleJson(schedule)),
  );
  if (schedule.deduplicationKey) {
    await redis.hset(
      keys.scheduleDedupe,
      schedule.deduplicationKey,
      schedule.id,
    );
  }
}

async function readScheduleCacheComplete(
  redis: Redis,
  keys: RedisStateKeys,
): Promise<boolean> {
  return (await redis.get(keys.schedulesComplete)) === '1';
}

async function markScheduleCacheComplete(
  redis: Redis,
  keys: RedisStateKeys,
): Promise<void> {
  await redis.set(keys.schedulesComplete, '1');
}

async function readSchedule(
  redis: Redis,
  keys: RedisStateKeys,
  id: string,
): Promise<QueueSchedule | undefined> {
  const raw = await redis.hget(keys.schedules, id);
  return raw ? parseSchedule(raw) : undefined;
}

async function readSchedules(
  redis: Redis,
  keys: RedisStateKeys,
): Promise<QueueSchedule[]> {
  const rows = await redis.hgetall(keys.schedules);
  return Object.values(rows).map(parseSchedule);
}

function isFullScheduleList(
  options: QueueScheduleListOptions | undefined,
): boolean {
  return (
    !options?.task &&
    !options?.externalId &&
    options?.active === undefined &&
    !options?.meta &&
    !options?.limit &&
    !options?.cursor
  );
}

function redisRunStore(
  redis: Redis,
  durable?: QueueStorage['runs'],
  keys: RedisStateKeys = defaultKeys,
): QueueState['runs'] {
  return {
    list: async (options) => {
      const persisted = await durable?.list(options);
      if (persisted) {
        await Promise.all(
          persisted.data.map((run) => writeRun(redis, keys, run)),
        );
        return persisted;
      }

      const runs = await readRuns(redis, keys);
      if (runs.length > 0) return filterRuns(runs, options);

      return { data: [], hasMore: false };
    },
  };
}

async function writeRun(
  redis: Redis,
  keys: RedisStateKeys,
  run: QueueRun,
): Promise<void> {
  await redis
    .multi()
    .hset(keys.runs, run.id, JSON.stringify(runJson(run)))
    .zadd(keys.runsIndex, run.updatedAt.getTime(), run.id)
    .expire(keys.runs, runCacheTtlSeconds)
    .expire(keys.runsIndex, runCacheTtlSeconds)
    .exec();
  await pruneRuns(redis, keys);
}

async function readRuns(
  redis: Redis,
  keys: RedisStateKeys,
): Promise<QueueRun[]> {
  const ids = await redis.zrevrange(keys.runsIndex, 0, maxCachedRuns - 1);
  if (ids.length > 0) {
    const rows = await redis.hmget(keys.runs, ...ids);
    return rows.filter((row): row is string => Boolean(row)).map(parseRun);
  }

  const rows = await redis.hgetall(keys.runs);
  return Object.values(rows).map(parseRun);
}

async function pruneRuns(redis: Redis, keys: RedisStateKeys): Promise<void> {
  const count = await redis.zcard(keys.runsIndex);
  if (count <= maxCachedRuns) return;

  const ids = await redis.zrange(keys.runsIndex, 0, count - maxCachedRuns - 1);
  if (ids.length === 0) return;

  await redis
    .multi()
    .hdel(keys.runs, ...ids)
    .zrem(keys.runsIndex, ...ids)
    .exec();
}

function redisAlertStore(
  redis: Redis,
  durable?: AlertStore,
  keys: RedisStateKeys = defaultKeys,
): AlertStore {
  return {
    getContactPoints: async () => {
      const rows = await readHash(redis, keys.alertContacts, parseContactPoint);
      if (rows.length > 0) return rows.sort(sortByName);
      const persisted = await durable?.getContactPoints();
      if (persisted?.length) {
        await Promise.all(
          persisted.map((point) => writeContactPoint(redis, keys, point)),
        );
        return persisted.sort(sortByName);
      }
      return [];
    },

    getContactPoint: async (id) => {
      const raw = await redis.hget(keys.alertContacts, id);
      if (raw) return parseContactPoint(raw);
      const persisted = await durable?.getContactPoint(id);
      if (persisted) await writeContactPoint(redis, keys, persisted);
      return persisted;
    },

    createContactPoint: async (input) => {
      const point =
        (await durable?.createContactPoint(input)) ?? contactPoint(input);
      await writeContactPoint(redis, keys, point);
      return point;
    },

    updateContactPoint: async (id, input) => {
      const point =
        (await durable?.updateContactPoint(id, input)) ??
        updateContactPoint(await readContactPoint(redis, keys, id), input);
      if (point) await writeContactPoint(redis, keys, point);
      return point;
    },

    deleteContactPoint: async (id) => {
      const redisDeleted = await redis.hdel(keys.alertContacts, id);
      const durableDeleted = await durable?.deleteContactPoint(id);
      return Boolean(durableDeleted ?? redisDeleted > 0);
    },

    getRules: async () => {
      const rows = await readHash(redis, keys.alertRules, parseRule);
      if (rows.length > 0) return rows.sort(sortByName);
      const persisted = await durable?.getRules();
      if (persisted?.length) {
        await Promise.all(
          persisted.map((rule) => writeRule(redis, keys, rule)),
        );
        return persisted.sort(sortByName);
      }
      return [];
    },

    getRule: async (id) => {
      const raw = await redis.hget(keys.alertRules, id);
      if (raw) return parseRule(raw);
      const persisted = await durable?.getRule(id);
      if (persisted) await writeRule(redis, keys, persisted);
      return persisted;
    },

    createRule: async (input) => {
      const rule = (await durable?.createRule(input)) ?? alertRule(input);
      await writeRule(redis, keys, rule);
      return rule;
    },

    updateRule: async (id, input) => {
      const rule =
        (await durable?.updateRule(id, input)) ??
        updateRule(await readRule(redis, keys, id), input);
      if (rule) await writeRule(redis, keys, rule);
      return rule;
    },

    deleteRule: async (id) => {
      const redisDeleted = await redis.hdel(keys.alertRules, id);
      const durableDeleted = await durable?.deleteRule(id);
      return Boolean(durableDeleted ?? redisDeleted > 0);
    },

    close: async () => {
      await durable?.close?.();
    },
  };
}

function scheduleJson(schedule: QueueSchedule) {
  return {
    ...schedule,
    nextRun: schedule.nextRun?.toISOString(),
    lastRun: schedule.lastRun?.toISOString(),
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

function parseSchedule(raw: string): QueueSchedule {
  const value = JSON.parse(raw) as Omit<
    QueueSchedule,
    'nextRun' | 'lastRun' | 'createdAt' | 'updatedAt'
  > & {
    nextRun?: string;
    lastRun?: string;
    createdAt: string;
    updatedAt: string;
  };
  return {
    ...value,
    nextRun: optionalDate(value.nextRun),
    lastRun: optionalDate(value.lastRun),
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
  };
}

function runJson(run: QueueRun) {
  return {
    ...run,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
  };
}

function parseRun(raw: string): QueueRun {
  const value = JSON.parse(raw) as Omit<
    QueueRun,
    'createdAt' | 'startedAt' | 'finishedAt' | 'updatedAt'
  > & {
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    updatedAt: string;
    error?: SerializedError;
  };
  return {
    ...value,
    createdAt: new Date(value.createdAt),
    startedAt: optionalDate(value.startedAt),
    finishedAt: optionalDate(value.finishedAt),
    updatedAt: new Date(value.updatedAt),
  };
}

function optionalDate(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

async function readHash<T>(
  redis: Redis,
  key: string,
  parse: (raw: string) => T,
): Promise<T[]> {
  const rows = await redis.hgetall(key);
  return Object.values(rows).map(parse);
}

function contactPoint(
  input: Omit<AlertContactPoint, 'id' | 'createdAt' | 'updatedAt'>,
): AlertContactPoint {
  const now = Date.now();
  return { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
}

function updateContactPoint(
  current: AlertContactPoint | undefined,
  input: Partial<Omit<AlertContactPoint, 'id' | 'createdAt' | 'updatedAt'>>,
): AlertContactPoint | undefined {
  if (!current) return undefined;
  return { ...current, ...input, updatedAt: Date.now() };
}

function alertRule(
  input: Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>,
): AlertRule {
  const now = Date.now();
  return { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
}

function updateRule(
  current: AlertRule | undefined,
  input: Partial<Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>>,
): AlertRule | undefined {
  if (!current) return undefined;
  return { ...current, ...input, updatedAt: Date.now() };
}

async function readContactPoint(
  redis: Redis,
  keys: RedisStateKeys,
  id: string,
): Promise<AlertContactPoint | undefined> {
  const raw = await redis.hget(keys.alertContacts, id);
  return raw ? parseContactPoint(raw) : undefined;
}

async function readRule(
  redis: Redis,
  keys: RedisStateKeys,
  id: string,
): Promise<AlertRule | undefined> {
  const raw = await redis.hget(keys.alertRules, id);
  return raw ? parseRule(raw) : undefined;
}

async function writeContactPoint(
  redis: Redis,
  keys: RedisStateKeys,
  point: AlertContactPoint,
): Promise<void> {
  await redis.hset(keys.alertContacts, point.id, JSON.stringify(point));
}

async function writeRule(
  redis: Redis,
  keys: RedisStateKeys,
  rule: AlertRule,
): Promise<void> {
  await redis.hset(keys.alertRules, rule.id, JSON.stringify(rule));
}

function parseContactPoint(raw: string): AlertContactPoint {
  return JSON.parse(raw) as AlertContactPoint;
}

function parseRule(raw: string): AlertRule {
  return JSON.parse(raw) as AlertRule;
}

function sortByName<T extends { name: string }>(a: T, b: T) {
  return a.name.localeCompare(b.name);
}
