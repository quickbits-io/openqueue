import postgres from 'postgres';

// The postgresAdapter path is user-owned migrations. drizzle-kit `push` can't
// drive a named pgSchema (it tries to DROP the whole `openqueue_demo` schema on
// every run, and errors when it doesn't yet exist), so — like the e2e suite —
// this provisions from `drizzle-kit export --sql`: the exact CREATE DDL for the
// tables `defineQueueSchema()` describes, with no diffing. Idempotent — once the
// schema is provisioned, re-running is a no-op.
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://openqueue:openqueue@localhost:5432/openqueue';
const SCHEMA = 'openqueue_demo';

const sql = postgres(DATABASE_URL, {
  max: 1,
  connect_timeout: 5,
  onnotice: () => {},
});

try {
  const existing = await sql`
    select 1 from information_schema.tables
    where table_schema = ${SCHEMA} and table_name = 'catalog'
    limit 1
  `;
  if (existing.length > 0) {
    console.log(`[demo] schema "${SCHEMA}" already provisioned`);
  } else {
    const ddl = await exportSchemaDdl();
    await sql.unsafe(`create schema if not exists "${SCHEMA}"`);
    await sql.unsafe(ddl);
    console.log(`[demo] provisioned schema "${SCHEMA}"`);
  }
} catch (cause) {
  console.error(
    `[demo] Postgres is not reachable at ${DATABASE_URL}.\n` +
      '       Start the local stack first: docker compose up --wait (repo root).',
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
    console.error('[demo] drizzle-kit export failed to emit schema DDL.');
    console.error(err);
    process.exit(1);
  }
  return out;
}
