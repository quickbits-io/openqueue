#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Bundle-graph gate for `@openqueue/world-postgres` (Phase 3 Stage C2): the
 * Postgres world must ship without dragging in the Redis stack. We bundle a
 * probe that imports the package entry and pins its namespace (forcing every
 * runtime export and its transitive deps to inline), then grep for ioredis /
 * bullmq. drizzle-orm and postgres are expected and allowed.
 *
 * Run after `bun run build`. Mirrors scripts/check-world-clean.ts.
 */
const entry = fileURLToPath(
  new URL('../packages/world-postgres/dist/index.js', import.meta.url),
);

const dir = await mkdtemp(join(tmpdir(), 'oq-world-pg-gate-'));
try {
  const probe = join(dir, 'probe.mjs');
  await writeFile(
    probe,
    `import * as world from ${JSON.stringify(entry)};\nglobalThis.__keep = world;\n`,
  );

  const outfile = join(dir, 'probe.bundle.js');
  try {
    await run('bun', ['build', probe, '--target=node', `--outfile=${outfile}`]);
  } catch (cause) {
    console.error('[world-pg-gate] failed to bundle the world-postgres entry:');
    console.error(cause);
    process.exit(1);
  }

  const code = await readFile(outfile, 'utf8');
  const leaks = ['ioredis', 'bullmq'].filter((mod) => code.includes(mod));
  if (leaks.length > 0) {
    console.error(
      `[world-pg-gate] @openqueue/world-postgres is NOT Redis-free — bundle references: ${leaks.join(', ')}`,
    );
    process.exit(1);
  }

  console.log(
    '[world-pg-gate] @openqueue/world-postgres is Redis-free (no ioredis/bullmq)',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
