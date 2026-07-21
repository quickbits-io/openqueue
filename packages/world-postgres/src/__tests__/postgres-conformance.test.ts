import { afterAll, beforeAll, describe } from 'vitest';
// Source-relative import (not a published subpath): the conformance harness is a
// vitest-importing dev module, shared with the in-repo world-postgres consumer
// only. Its type-only `./types` import keeps the runtime graph to just vitest.
import { describeTransportConformance } from '../../../core/src/transport/conformance';
import { createPostgresTransport } from '../transport';
import { hasDb, resetSchema, testClient, uniqueNamespace } from './test-db';

describe.runIf(hasDb)('world-postgres conformance', () => {
  const sql = testClient();
  const namespace = uniqueNamespace('conf');
  const transport = createPostgresTransport({
    sql,
    namespace,
    poll: { intervalMs: 100 },
  });

  beforeAll(async () => {
    await resetSchema(sql);
  });
  afterAll(async () => {
    await sql.end();
  });

  // `flows: false` → the flow scenario self-skips; every other scenario runs.
  describeTransportConformance({
    name: 'world-postgres',
    create: () => transport,
    timing: { settleMs: 5000, delayMs: 800 },
  });
});
