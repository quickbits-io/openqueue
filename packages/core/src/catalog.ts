import type { Redis } from 'ioredis';
import { DEFAULT_NAMESPACE, redisKey } from './namespace';
import type {
  QueueCatalogEntry,
  QueueCatalogStore,
  TaskDefinition,
} from './types';

export const queueCatalogKey = catalogKey(DEFAULT_NAMESPACE);
export const queueCatalogPublishedAtKey =
  catalogPublishedAtKey(DEFAULT_NAMESPACE);

export function catalogKey(namespace: string): string {
  return redisKey(namespace, 'catalog');
}

export function catalogPublishedAtKey(namespace: string): string {
  return redisKey(namespace, 'catalog:published_at');
}

export function taskCatalogEntry(
  def: TaskDefinition,
  updatedAt = new Date().toISOString(),
): QueueCatalogEntry {
  return {
    id: def.id,
    name: def.name,
    queue: def.queue,
    attempts: def.attempts,
    backoff: def.backoff,
    concurrency: def.concurrency,
    ttl: def.ttl,
    maxStalledCount: def.maxStalledCount,
    cron: def.cron,
    tags: def.tags,
    description: def.description,
    schema: schemaMetadata(def.schema),
    updatedAt,
    version: updatedAt,
  };
}

export function queueCatalogEntries(
  tasks: TaskDefinition[],
  updatedAt = new Date().toISOString(),
): QueueCatalogEntry[] {
  return tasks.map((def) => taskCatalogEntry(def, updatedAt));
}

export async function writeQueueCatalog(
  redis: Redis,
  entries: QueueCatalogEntry[],
  namespace = DEFAULT_NAMESPACE,
): Promise<void> {
  const key = catalogKey(namespace);
  const publishedAtKey = catalogPublishedAtKey(namespace);
  const updatedAt = entries[0]?.updatedAt ?? new Date().toISOString();
  const payload = Object.fromEntries(
    entries.map((entry) => [entry.id, JSON.stringify(entry)]),
  );

  await redis.del(key);
  if (entries.length > 0) await redis.hset(key, payload);
  await redis.set(publishedAtKey, updatedAt);
}

export async function publishQueueCatalog(
  redis: Redis,
  tasks: TaskDefinition[],
  stores: QueueCatalogStore[] = [],
  namespace = DEFAULT_NAMESPACE,
): Promise<QueueCatalogEntry[]> {
  const entries = queueCatalogEntries(tasks);
  await writeQueueCatalog(redis, entries, namespace);
  await Promise.all(stores.map((store) => store.publish(entries)));

  return entries;
}

export async function readQueueCatalog(
  redis: Redis,
  namespace = DEFAULT_NAMESPACE,
): Promise<QueueCatalogEntry[]> {
  const values = await redis.hgetall(catalogKey(namespace));
  return Object.values(values).map(parseCatalogEntry);
}

export async function resolveQueueCatalogTask(
  redis: Redis,
  id: string,
  namespace = DEFAULT_NAMESPACE,
): Promise<QueueCatalogEntry> {
  const raw = await redis.hget(catalogKey(namespace), id);
  if (!raw) {
    throw new Error(
      `Unknown task "${id}"; worker catalog has not been published`,
    );
  }
  return parseCatalogEntry(raw);
}

export function catalogEntryDefinition(
  entry: QueueCatalogEntry,
): TaskDefinition {
  return {
    id: entry.id,
    name: entry.name,
    queue: entry.queue,
    description: entry.description,
    handler: async () => undefined,
    concurrency: entry.concurrency,
    attempts: entry.attempts,
    backoff: entry.backoff,
    cron: entry.cron,
    ttl: entry.ttl,
    maxStalledCount: entry.maxStalledCount,
    tags: entry.tags,
  };
}

export function memoryQueueCatalogStore(
  initial: QueueCatalogEntry[] = [],
): QueueCatalogStore {
  const entries = new Map(initial.map((entry) => [entry.id, entry]));
  return {
    publish: async (next) => {
      entries.clear();
      for (const entry of next) entries.set(entry.id, entry);
    },
    resolve: async (id) => entries.get(id),
    read: async () => Array.from(entries.values()),
  };
}

export function parseCatalogEntry(raw: string): QueueCatalogEntry {
  const value = JSON.parse(raw) as QueueCatalogEntry;
  return value;
}

function schemaMetadata(schema: TaskDefinition['schema']) {
  if (!schema) return undefined;
  return { type: schema.constructor.name };
}
