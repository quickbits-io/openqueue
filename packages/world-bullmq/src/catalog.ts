import { DEFAULT_NAMESPACE, taskCatalogEntry } from '@openqueue/core';
import type {
  QueueCatalogEntry,
  QueueCatalogStore,
  TaskDefinition,
} from '@openqueue/core/types';
import type { Redis } from 'ioredis';
import { redisKey } from './state';

export const queueCatalogKey = catalogKey(DEFAULT_NAMESPACE);
export const queueCatalogPublishedAtKey =
  catalogPublishedAtKey(DEFAULT_NAMESPACE);

export function catalogKey(namespace: string): string {
  return redisKey(namespace, 'catalog');
}

export function catalogPublishedAtKey(namespace: string): string {
  return redisKey(namespace, 'catalog:published_at');
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
  const updatedAt = new Date().toISOString();
  const entries = tasks.map((def) => taskCatalogEntry(def, updatedAt));
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

export function parseCatalogEntry(raw: string): QueueCatalogEntry {
  const value = JSON.parse(raw) as QueueCatalogEntry;
  return value;
}
