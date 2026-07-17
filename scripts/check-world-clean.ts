#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Import-clean gate for the public `@openqueue/core/world` entry (Phase 3
 * Stage C freeze): a third-party transport must be able to depend on the world
 * contract without dragging in ioredis or bullmq. We bundle a probe that
 * imports the entry and grep the output for those modules.
 *
 * We bundle a *consumer* of the entry rather than the entry file directly:
 * `dist/world.js` is a pure re-export, which `bun build` tree-shakes to a bare
 * export list (dropping the bodies that a direct grep would need to inspect).
 * Importing and pinning the namespace forces every runtime export — and its
 * transitive dependencies — to be inlined, so a leak would surface.
 *
 * Run after `bun run build`. Wired into CI (see .github/workflows/ci.yml).
 */
const worldEntry = fileURLToPath(
  new URL('../packages/core/dist/world.js', import.meta.url),
);

const dir = await mkdtemp(join(tmpdir(), 'oq-world-gate-'));
try {
  const probe = join(dir, 'probe.mjs');
  await writeFile(
    probe,
    `import * as world from ${JSON.stringify(worldEntry)};\nglobalThis.__keep = world;\n`,
  );

  const outfile = join(dir, 'probe.bundle.js');
  try {
    await run('bun', ['build', probe, '--target=node', `--outfile=${outfile}`]);
  } catch (cause) {
    console.error('[world-gate] failed to bundle the world entry:');
    console.error(cause);
    process.exit(1);
  }

  const code = await readFile(outfile, 'utf8');
  const leaks = ['ioredis', 'bullmq'].filter((mod) => code.includes(mod));
  if (leaks.length > 0) {
    console.error(
      `[world-gate] @openqueue/core/world is NOT import-clean — bundle references: ${leaks.join(', ')}`,
    );
    process.exit(1);
  }

  console.log(
    '[world-gate] @openqueue/core/world is import-clean (no ioredis/bullmq)',
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
