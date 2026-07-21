#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Phantom-dependency gate for `@openqueue/core` (WS1 — the world-bullmq
 * extraction). The engine must ship without ioredis/bullmq in ANY of its
 * published entries. Hoisting can make a stray `import 'bullmq'` typecheck and
 * even bundle, so a source grep is not enough: we bundle EVERY dist entry
 * (namespace-pinned, so tree-shaken re-exports are forced back into the graph)
 * and assert that neither module is LINKED.
 *
 * "Linked" means bun inlined the package — it emits a `// node_modules/<pkg>/…`
 * header per inlined file — or left an external `from "<pkg>"` /
 * `require("<pkg>")` / `import("<pkg>")` specifier. A bare string literal (e.g.
 * the `messaging.system: 'bullmq'` telemetry label in worker.ts) is NOT linkage,
 * so the gate never matches on the bare word.
 *
 * Run after `bun run build`. Mirrors scripts/check-world-clean.ts. Wired into CI.
 */
const ENTRIES = ['index', 'auth', 'control', 'drizzle', 'types', 'world'];
const FORBIDDEN = ['ioredis', 'bullmq'];

function entryPath(name: string): string {
  return fileURLToPath(
    new URL(`../packages/core/dist/${name}.js`, import.meta.url),
  );
}

function linkedModules(code: string): string[] {
  return FORBIDDEN.filter((mod) => {
    if (code.includes(`node_modules/${mod}/`)) return true;
    const specifier = new RegExp(
      `(?:from|require\\(|import\\()\\s*["']${mod}(?:/[^"']*)?["']`,
    );
    return specifier.test(code);
  });
}

const dir = await mkdtemp(join(tmpdir(), 'oq-core-gate-'));
try {
  for (const name of ENTRIES) {
    const entry = entryPath(name);
    const probe = join(dir, `probe.${name}.mjs`);
    await writeFile(
      probe,
      `import * as entry from ${JSON.stringify(entry)};\nglobalThis.__keep = entry;\n`,
    );

    const outfile = join(dir, `probe.${name}.bundle.js`);
    try {
      await run('bun', [
        'build',
        probe,
        '--target=node',
        `--outfile=${outfile}`,
      ]);
    } catch (cause) {
      console.error(`[core-gate] failed to bundle @openqueue/core (${name}):`);
      console.error(cause);
      process.exit(1);
    }

    const code = await readFile(outfile, 'utf8');
    const leaks = linkedModules(code);
    if (leaks.length > 0) {
      const label =
        name === 'index' ? '@openqueue/core' : `@openqueue/core/${name}`;
      console.error(
        `[core-gate] ${label} links a forbidden module: ${leaks.join(', ')}`,
      );
      process.exit(1);
    }
  }

  console.log(
    `[core-gate] all ${ENTRIES.length} @openqueue/core entries are ioredis/bullmq-free`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
