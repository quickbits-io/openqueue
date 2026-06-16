import { Redis } from 'ioredis';

export interface QueueConnection {
  producer: Redis;
  worker: Redis;
  subscriber: Redis;
}

export function createConnection(redisUrl?: string): QueueConnection {
  const url = redisUrl ?? process.env.REDIS_URL;
  if (!url) {
    throw new Error(
      '@openqueue/sdk: REDIS_URL is required. Pass `createConnection(url)` or set process.env.REDIS_URL.',
    );
  }

  const producer = new Redis(url, { lazyConnect: true });
  const worker = new Redis(url, {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });
  const subscriber = new Redis(url, { lazyConnect: true });

  return { producer, worker, subscriber };
}

export async function closeConnection(conn: QueueConnection): Promise<void> {
  await Promise.all([
    conn.producer.quit().catch(() => undefined),
    conn.worker.quit().catch(() => undefined),
    conn.subscriber.quit().catch(() => undefined),
  ]);
}
