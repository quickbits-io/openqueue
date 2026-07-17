import { Redis } from 'ioredis';
import {
  catalogKey,
  parseCatalogEntry,
  readQueueCatalog,
  writeQueueCatalog,
} from './catalog';
import { createRedisQueueState } from './state';
import { createBullmqTransport } from './transport/bullmq';
import type {
  QueueCatalogEntry,
  QueueCatalogStore,
  QueueStorage,
} from './types';
import {
  type OpenQueueWorld,
  WORLD_SPEC_VERSION,
  type WorldContext,
} from './world';

/**
 * A BullMQ-backed world. Supply either a connection `url` (the world creates
 * and owns a producer + blocking consumer, quitting both on close) or your own
 * `producer` (and optional blocking `consumer`), which the world leaves open.
 */
export type WorldBullmqOptions = (
  | { url: string; producer?: undefined; consumer?: undefined }
  | { producer: Redis; consumer?: Redis; url?: undefined }
) & {
  storage?: QueueStorage;
  /** Catalog stores consulted after Redis, in order. */
  catalogFallbacks?: QueueCatalogStore[];
};

export function worldBullmq(
  options: WorldBullmqOptions,
): (ctx: WorldContext) => OpenQueueWorld {
  return (ctx) => {
    const namespace = ctx.namespace;
    const { producer, consumer, owned } = resolveClients(options);
    const transport = createBullmqTransport({
      producer,
      consumer,
      ...namespace,
    });
    const state = createRedisQueueState(producer, options.storage, namespace);
    const fallbacks = options.catalogFallbacks ?? [];

    const store: QueueStorage = {
      ...state,
      spans: options.storage?.spans,
      publish: async (entries) => {
        await writeQueueCatalog(producer, entries, namespace.namespace);
        await Promise.all(
          fallbacks.map((fallback) => fallback.publish(entries)),
        );
      },
      resolve: (id) =>
        resolveWorldCatalog(producer, fallbacks, id, namespace.namespace),
      read: () => readWorldCatalog(producer, fallbacks, namespace.namespace),
    };

    return {
      specVersion: WORLD_SPEC_VERSION,
      transport,
      store,
      close: async () => {
        await transport.close();
        await store.alerts.close?.();
        if (owned) {
          await producer.quit().catch(() => undefined);
          await consumer.quit().catch(() => undefined);
        }
      },
    };
  };
}

/**
 * Resolve the producer/consumer pair from the option shape. The `url` form
 * mints internally-owned clients (lazyConnect; the consumer is a blocking
 * connection) that `world.close()` quits; the `producer` form hands ownership
 * back to the caller.
 */
function resolveClients(options: WorldBullmqOptions): {
  producer: Redis;
  consumer: Redis;
  owned: boolean;
} {
  if (options.url !== undefined) {
    return {
      producer: new Redis(options.url, { lazyConnect: true }),
      consumer: new Redis(options.url, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
      }),
      owned: true,
    };
  }
  return {
    producer: options.producer,
    consumer: options.consumer ?? options.producer,
    owned: false,
  };
}

async function resolveWorldCatalog(
  redis: Redis,
  fallbacks: QueueCatalogStore[],
  id: string,
  namespace: string,
): Promise<QueueCatalogEntry | undefined> {
  try {
    const raw = await redis.hget(catalogKey(namespace), id);
    if (raw) return parseCatalogEntry(raw);
  } catch (err) {
    const entry = await resolveFromFallbacks(fallbacks, id);
    if (entry) return entry;
    throw err;
  }
  return resolveFromFallbacks(fallbacks, id);
}

async function resolveFromFallbacks(
  fallbacks: QueueCatalogStore[],
  id: string,
): Promise<QueueCatalogEntry | undefined> {
  for (const store of fallbacks) {
    const entry = await store.resolve(id);
    if (entry) return entry;
  }
  return undefined;
}

async function readWorldCatalog(
  redis: Redis,
  fallbacks: QueueCatalogStore[],
  namespace: string,
): Promise<QueueCatalogEntry[]> {
  const entries = await readQueueCatalog(redis, namespace);
  if (entries.length > 0) return entries;

  for (const store of fallbacks) {
    const stored = await store.read();
    if (stored.length > 0) return stored;
  }

  return [];
}
