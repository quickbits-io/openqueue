import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe } from 'vitest';
import { createBullmqTransport } from '../bullmq';
import { describeTransportConformance } from '../conformance';

const url = process.env.REDIS_URL;

describe.skipIf(!url)('bullmq transport', () => {
  // Fresh namespace per run so leftover keys never cross-contaminate.
  const namespace = `conf-${randomUUID().slice(0, 8)}`;
  const connection = new Redis(url ?? 'redis://localhost:6380', {
    maxRetriesPerRequest: null,
    lazyConnect: true,
  });

  afterAll(async () => {
    await connection.quit().catch(() => undefined);
  });

  describeTransportConformance({
    name: 'bullmq',
    create: () => createBullmqTransport({ producer: connection, namespace }),
  });
});
