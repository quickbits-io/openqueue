import Redis from 'ioredis';
import postgres from 'postgres';
import { DATABASE_URL, PG_SCHEMA, REDIS_URL, WORLD } from './env';

const hint =
  'Start the stack and prepare the schema first: `bun run e2e` from the repo root ' +
  '(or `docker compose up --wait` + `bun run db:reset` here).';

// A throwing `bun test` preload surfaces as an async rejection that does NOT
// abort the run — the test files still boot and hang on BullMQ's reconnect. To
// fail fast and loud, print the actionable message and exit the process.
function abort(message: string, cause?: unknown): never {
  console.error(message);
  if (cause !== undefined) console.error(cause);
  process.exit(1);
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// The postgres world runs with a poisoned REDIS_URL to prove it never touches
// Redis; skip the Redis probe in that mode.
if (WORLD !== 'postgres') {
  const redis = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 3000,
    enableOfflineQueue: false,
  });
  // Without an error listener ioredis's ECONNREFUSED handling is undefined under
  // Bun and `connect()` can hang instead of rejecting; the timeout is the backstop.
  redis.on('error', () => {});
  try {
    await withTimeout(
      (async () => {
        await redis.connect();
        await redis.ping();
      })(),
      5000,
    );
  } catch (cause) {
    abort(`[e2e] Redis is not reachable at ${REDIS_URL}. ${hint}`, cause);
  } finally {
    redis.disconnect();
  }
}

const sql = postgres(DATABASE_URL, {
  max: 1,
  connect_timeout: 5,
  onnotice: () => {},
});
let schemaExists = false;
try {
  if (WORLD === 'postgres') {
    // The worker self-migrates `openqueue` on boot, so only reachability matters.
    await withTimeout(sql`select 1`, 8000);
    schemaExists = true;
  } else {
    const rows = await withTimeout(
      sql`
      select 1 from information_schema.schemata where schema_name = ${PG_SCHEMA}`,
      8000,
    );
    schemaExists = rows.length > 0;
  }
} catch (cause) {
  abort(`[e2e] Postgres is not reachable at ${DATABASE_URL}. ${hint}`, cause);
} finally {
  await sql.end();
}

if (!schemaExists) {
  abort(`[e2e] Postgres schema "${PG_SCHEMA}" is missing. ${hint}`);
}
