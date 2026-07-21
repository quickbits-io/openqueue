import { composeDrains } from '@openqueue/core';
import type { QueueCatalogEntry, QueueStorage } from '@openqueue/core/types';
import {
  type OpenQueueWorld,
  WORLD_SPEC_VERSION,
  type WorldContext,
} from '@openqueue/core/world';
import { Redis } from 'ioredis';
import {
  catalogKey,
  parseCatalogEntry,
  readQueueCatalog,
  writeQueueCatalog,
} from './catalog';
import { createRedisQueueState } from './state';
import { createBullmqTransport } from './transport';

/**
 * A BullMQ-backed world: a Redis delivery transport paired with a write-through
 * durable state store. Supply either a connection `url` (the world creates and
 * owns a producer + blocking consumer, quitting both on close) or your own
 * `producer` (left open by the world). When you pass a `producer` without a
 * `consumer`, the world duplicates it into a worker-safe blocking connection it
 * owns — a bare `producer` isn't usable for BullMQ workers on its own.
 *
 * `storage` (e.g. a `postgresAdapter`) is the durable backing for schedules and
 * runs and doubles as the sole catalog fallback consulted after Redis.
 */
export type WorldBullmqOptions = (
  | { url: string; producer?: undefined; consumer?: undefined }
  | { producer: Redis; consumer?: Redis; url?: undefined }
) & {
  /** Root BullMQ key prefix; the transport uses `${prefix}:${namespace}`. Default 'bull'. */
  prefix?: string;
  /** Durable store — also the sole catalog fallback consulted after Redis. */
  storage?: QueueStorage;
};

export function worldBullmq(
  options: WorldBullmqOptions,
): (ctx: WorldContext) => OpenQueueWorld {
  return (ctx: WorldContext): OpenQueueWorld => {
    const namespace = ctx.namespace;
    const { producer, consumer, ownedClients } = resolveClients(options);
    const transport = createBullmqTransport({
      producer,
      consumer,
      namespace,
      prefix: options.prefix,
    });
    const state = createRedisQueueState(producer, options.storage, namespace);
    const storage = options.storage;

    const store: QueueStorage = {
      ...state,
      spans: storage?.spans,
      // Run events write through to Redis AND the durable store — the world owns
      // durable persistence, so it drains both (the state store's own `handle`
      // only touches Redis; `storage` is otherwise read-through + catalog).
      handle: storage ? composeDrains(state, storage).handle : state.handle,
      publish: async (entries) => {
        await writeQueueCatalog(producer, entries, namespace);
        if (storage) await storage.publish(entries);
      },
      resolve: (id) => resolveWorldCatalog(producer, storage, id, namespace),
      read: () => readWorldCatalog(producer, storage, namespace),
    };

    return {
      specVersion: WORLD_SPEC_VERSION,
      transport,
      store,
      close: async () => {
        // Settle both phases before quitting the owned clients: a rejected
        // transport close must not strand world-owned Redis handles. The first
        // failure still surfaces, after cleanup.
        const results = await Promise.allSettled([
          transport.close(),
          Promise.resolve().then(() => store.alerts.close?.()),
        ]);
        await Promise.all(
          ownedClients.map((client) => client.quit().catch(() => undefined)),
        );
        const failure = results.find(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected',
        );
        if (failure) throw failure.reason;
      },
    };
  };
}

/**
 * Resolve the producer/consumer pair and the set of clients `world.close()`
 * must quit. The `url` form mints two internally-owned clients (lazyConnect; the
 * consumer is a blocking connection). An injected `producer` is left to the
 * caller; an injected `consumer` too. But a `producer` supplied *without* a
 * `consumer` is not worker-safe on its own — BullMQ blocking connections must
 * set `maxRetriesPerRequest: null` — so the world duplicates it into a
 * world-owned blocking consumer, leaving the caller's producer untouched.
 */
function resolveClients(options: WorldBullmqOptions): {
  producer: Redis;
  consumer: Redis;
  ownedClients: Redis[];
} {
  if (options.url !== undefined) {
    const producer = new Redis(options.url, { lazyConnect: true });
    const consumer = new Redis(options.url, {
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    return { producer, consumer, ownedClients: [producer, consumer] };
  }
  const producer = options.producer;
  if (options.consumer) {
    return { producer, consumer: options.consumer, ownedClients: [] };
  }
  const consumer = producer.duplicate({ maxRetriesPerRequest: null });
  return { producer, consumer, ownedClients: [consumer] };
}

async function resolveWorldCatalog(
  redis: Redis,
  storage: QueueStorage | undefined,
  id: string,
  namespace: string,
): Promise<QueueCatalogEntry | undefined> {
  try {
    const raw = await redis.hget(catalogKey(namespace), id);
    if (raw) return parseCatalogEntry(raw);
  } catch (err) {
    const entry = await storage?.resolve(id);
    if (entry) return entry;
    throw err;
  }
  return storage?.resolve(id);
}

async function readWorldCatalog(
  redis: Redis,
  storage: QueueStorage | undefined,
  namespace: string,
): Promise<QueueCatalogEntry[]> {
  const entries = await readQueueCatalog(redis, namespace);
  if (entries.length > 0) return entries;
  return (await storage?.read()) ?? [];
}
