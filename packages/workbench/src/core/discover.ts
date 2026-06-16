import { Queue } from 'bullmq';
import type { RedisOptions } from 'ioredis';
import { Redis } from 'ioredis';

/**
 * Discover BullMQ queues on a Redis connection by scanning for `<prefix>:*:meta`
 * keys. Returns one `Queue` instance per discovered queue, each constructed
 * with a fresh clone of the connection options.
 *
 * Used by `WorkbenchCore.fromOptions` for the desktop client where the user
 * supplies a Redis URL but no explicit queue list.
 */
export async function discoverQueues(
  connection: string | RedisOptions,
  prefix = 'bull',
): Promise<Queue[]> {
  const normalized = normalizeConnection(connection);
  const client = createScanClient(normalized);

  // Surface the underlying connection error (ECONNREFUSED, NOAUTH, EAI_AGAIN,
  // ENOTFOUND, TLS errors, etc.) rather than letting ioredis bury it under a
  // "max retries per request" wrapper. We swap the first error in via the
  // event listener and reject the ping promise with it.
  const firstError = captureFirstError(client);

  try {
    await Promise.race([client.ping(), firstError.promise]);
    const names = await scanQueueNames(client, prefix);
    return names.map(
      (name) =>
        new Queue(name, {
          connection: { ...normalized },
          prefix,
        }),
    );
  } finally {
    firstError.dispose();
    client.disconnect();
  }
}

function captureFirstError(client: Redis): {
  promise: Promise<never>;
  dispose: () => void;
} {
  let onError: ((err: Error) => void) | null = null;
  const promise = new Promise<never>((_, reject) => {
    onError = (err) => reject(err);
    client.once('error', onError);
  });
  // Swallow further errors after the first so ioredis doesn't kill the
  // process with an "unhandled error event" once we've already rejected.
  client.on('error', () => {});
  return {
    promise,
    dispose: () => {
      if (onError) client.off('error', onError);
    },
  };
}

/**
 * Normalize a `string | RedisOptions` connection into a single `RedisOptions`
 * shape with `{ url }` (when a URL string was passed). BullMQ's `Queue`
 * accepts `{ url: "redis://..." }` but not a bare URL string, so this is the
 * canonical adapter form.
 */
function normalizeConnection(
  connection: string | RedisOptions,
): RedisOptions & { url?: string } {
  if (typeof connection === 'string') {
    return { url: connection };
  }
  return { ...connection };
}

function createScanClient(opts: RedisOptions & { url?: string }): Redis {
  // ioredis accepts the `url` field directly via its constructor; we pass it
  // explicitly to make the `bun build --compile` static analysis happy.
  const { url, ...rest } = opts;
  if (url) {
    return new Redis(url, {
      ...rest,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
    });
  }
  return new Redis({ ...rest, lazyConnect: false, maxRetriesPerRequest: 1 });
}

/**
 * Cursored SCAN for `<prefix>:*:meta` keys. BullMQ writes a meta key for each
 * queue on first use; using that as the discovery signal avoids matching
 * jobs, locks, or other namespaced sub-keys.
 */
async function scanQueueNames(
  client: Redis,
  prefix: string,
): Promise<string[]> {
  const pattern = `${prefix}:*:meta`;
  const names = new Set<string>();
  let cursor = '0';

  do {
    const [next, batch] = await client.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      500,
    );
    cursor = next;
    for (const key of batch) {
      const name = parseQueueName(key, prefix);
      if (name) names.add(name);
    }
  } while (cursor !== '0');

  return Array.from(names).sort();
}

function parseQueueName(key: string, prefix: string): string | null {
  const head = `${prefix}:`;
  const tail = ':meta';
  if (!key.startsWith(head) || !key.endsWith(tail)) return null;
  return key.slice(head.length, key.length - tail.length);
}
