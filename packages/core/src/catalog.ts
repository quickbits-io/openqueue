import type {
  QueueCatalogEntry,
  QueueCatalogStore,
  TaskDefinition,
} from './types';

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

function schemaMetadata(schema: TaskDefinition['schema']) {
  if (!schema) return undefined;
  return { type: schema.constructor.name };
}
