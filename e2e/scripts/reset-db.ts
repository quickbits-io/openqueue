import postgres from 'postgres';
import { DATABASE_URL, PG_SCHEMA, WORLD } from '../src/env';

const sql = postgres(DATABASE_URL, {
  max: 1,
  connect_timeout: 5,
  onnotice: () => {},
});

try {
  if (WORLD === 'postgres') {
    // The worker self-migrates the `openqueue` schema on boot (world.start()),
    // so we only drop it — every run then exercises the migration runner.
    await sql.unsafe(`drop schema if exists "${PG_SCHEMA}" cascade`);
    console.log(`[e2e] dropped schema "${PG_SCHEMA}" (worker self-migrates)`);
  } else {
    // `drizzle-kit push` is unusable here: with a `pgSchema` + `schemaFilter` it
    // creates the tables but appends a spurious `DROP SCHEMA` that errors, and
    // masks the failure with exit 0. `drizzle-kit export --sql` emits the exact
    // same DDL from `defineQueueSchema()` (the documented persistence flow) with
    // no diffing, so we create the empty schema ourselves and apply it.
    const ddl = await exportSchemaDdl();
    await sql.unsafe(`drop schema if exists "${PG_SCHEMA}" cascade`);
    await sql.unsafe(`create schema "${PG_SCHEMA}"`);
    await sql.unsafe(ddl);
    console.log(`[e2e] reset schema "${PG_SCHEMA}"`);
  }
} catch (cause) {
  console.error(
    `[e2e] Postgres is not reachable at ${DATABASE_URL}.\n` +
      '      Start the local stack first: docker compose up --wait (repo root).',
  );
  console.error(cause);
  process.exit(1);
} finally {
  await sql.end();
}

async function exportSchemaDdl(): Promise<string> {
  const proc = Bun.spawn(['bunx', 'drizzle-kit', 'export', '--sql'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 || out.trim().length === 0) {
    console.error('[e2e] drizzle-kit export failed to emit schema DDL.');
    console.error(err);
    process.exit(1);
  }
  return out;
}
