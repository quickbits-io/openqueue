import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { runMigrations } from '../migrate';
import { migrations } from '../migrations';

export const DATABASE_URL = process.env.DATABASE_URL ?? '';
export const hasDb = DATABASE_URL.length > 0;

/** A quiet client (notices suppressed) for a suite that owns its own lifecycle. */
export function testClient(): postgres.Sql {
  return postgres(DATABASE_URL, { onnotice: () => {} });
}

/** A namespace unique to a test, so suites never steal each other's jobs. */
export function uniqueNamespace(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Drop and rebuild the `openqueue` schema, then apply the committed migrations. */
export async function resetSchema(sql: postgres.Sql): Promise<void> {
  await sql.unsafe('drop schema if exists "openqueue" cascade');
  await runMigrations(sql, migrations, 'auto');
}
