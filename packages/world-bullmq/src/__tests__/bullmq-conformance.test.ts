import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { afterAll, describe } from 'vitest';
// Source-relative import (not a published subpath): the conformance harness is a
// vitest-coupled test fixture with no external consumers, so it is not frozen on
// a `@openqueue/core` subpath at 1.0.
import { describeTransportConformance } from '../../../core/src/transport/conformance';
import { createBullmqTransport } from '../transport';

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
