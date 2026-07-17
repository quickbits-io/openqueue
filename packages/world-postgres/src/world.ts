import { postgresAdapter } from '@openqueue/core/drizzle';
import {
  type OpenQueueWorld,
  WORLD_SPEC_VERSION,
  type WorldFactory,
} from '@openqueue/core/world';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type MigrationMode, migrationStatus, runMigrations } from './migrate';
import { migrations } from './migrations';
import { queueSchema } from './schema';
import {
  createPostgresTransport,
  type PostgresTransportPollOptions,
} from './transport';

export interface WorldPostgresOptions {
  /** Connection string; the world creates and owns the client, ending it on close. */
  url?: string;
  /** An existing postgres.js client; the world uses it and leaves it open. XOR with `url`. */
  db?: postgres.Sql;
  /**
   * Whether `world.start()` applies pending migrations. `'manual'` (default)
   * fails on a pending migration with an actionable message; `'auto'` applies
   * them under an advisory lock on boot.
   */
  migrations?: MigrationMode;
  /** Poll cadence for the delivery transport. */
  poll?: PostgresTransportPollOptions;
}

/**
 * A self-migrating Postgres world: a `SELECT ... FOR UPDATE SKIP LOCKED`
 * transport plus a `postgresAdapter` durable store, both over the fixed
 * `openqueue` schema. Imports only `@openqueue/core/drizzle` and
 * `@openqueue/core/world`, so the bundle stays free of ioredis/bullmq.
 *
 * Supply exactly one of `url` (world-owned client) or `db` (caller-owned). The
 * store and transport share the connection; `close()` ends it only when owned.
 */
export function worldPostgres(options: WorldPostgresOptions): WorldFactory {
  if ((options.url !== undefined) === (options.db !== undefined)) {
    throw new Error(
      '@openqueue/world-postgres: worldPostgres requires exactly one of `url` or `db`',
    );
  }
  const mode: MigrationMode = options.migrations ?? 'manual';

  return (ctx): OpenQueueWorld => {
    const { sql, owned } = resolveSql(options);
    const transport = createPostgresTransport({
      sql,
      namespace: ctx.namespace.namespace,
      poll: options.poll,
    });
    const store = postgresAdapter({ db: drizzle(sql), schema: queueSchema });

    return {
      specVersion: WORLD_SPEC_VERSION,
      transport,
      store,
      migrations: {
        steps: migrations,
        status: () => migrationStatus(sql, migrations),
      },
      start: () => runMigrations(sql, migrations, mode),
      close: async () => {
        await transport.close();
        if (owned) await sql.end();
      },
    };
  };
}

function resolveSql(options: WorldPostgresOptions): {
  sql: postgres.Sql;
  owned: boolean;
} {
  if (options.db !== undefined) return { sql: options.db, owned: false };
  if (options.url !== undefined) {
    // Suppress `NOTICE: relation ... already exists` chatter from idempotent
    // `create ... if not exists` migration DDL on boot. Only for the client we
    // own; an injected `db` keeps its caller-configured notice handling.
    return { sql: postgres(options.url, { onnotice: () => {} }), owned: true };
  }
  throw new Error(
    '@openqueue/world-postgres: worldPostgres requires exactly one of `url` or `db`',
  );
}
