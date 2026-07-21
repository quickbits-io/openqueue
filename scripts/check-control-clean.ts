#!/usr/bin/env bun

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Bundle-graph gate for the split-control-plane entries (Phase 3 Stage D). A
 * two-plane deployment serves the control API from an edge/serverless runtime,
 * so `@openqueue/core/auth`, `@openqueue/core/control`, and
 * `@openqueue/workbench/control` must ship without the Redis/BullMQ stack and be
 * buildable for a browser/edge target. Mirrors scripts/check-world-clean.ts:
 * shells to the `bun build` CLI (never the Bun.build API) and bundles a
 * namespace-pinning *consumer* of each entry so tree-shaken re-exports are
 * forced back into the graph.
 *
 * Two passes per probe:
 *   - `--target=node`   — must reference neither `ioredis` nor `bullmq`.
 *   - `--target=browser`— must BUILD, reference neither `ioredis` nor `bullmq`,
 *     and pull in only Workers `nodejs_compat`-safe node builtins.
 *
 * The only source-level `node:` import in the control graph is `node:crypto`
 * (the enqueuer's `randomUUID` — kept over global `crypto.randomUUID`, which is
 * flag-gated on Node 18). bun's browser polyfill for `node:crypto` inlines its
 * own deps (`buffer`, `events`, `stream`, `util`); all are `nodejs_compat`
 * builtins and none imply a socket, native addon, or filesystem dependency — the
 * leaks a Redis/Postgres driver would add.
 *
 * Third pass — SOURCE import-graph scan. The browser-bundle allowlist has a
 * blind spot: bun silently stubs some node builtins (`node:fs`, `node:tls`,
 * `node:child_process`, …) with no polyfill marker, so a dist grep can miss a
 * leak. To close it we statically walk the `src/` value-import graph reachable
 * from each entry and assert the exact set of `node:*` specifiers — source uses
 * `node:` prefixes consistently, so the scan is reliable where the dist grep is
 * not. The control graph may reach only `node:crypto`; auth and
 * workbench-control must reach none.
 *
 * Run after `bun run build`. Wired into CI (see .github/workflows/ci.yml).
 */
const ALLOWED_BROWSER_NODE = new Set([
  'crypto',
  'buffer',
  'events',
  'stream',
  'util',
]);

interface Probe {
  name: string;
  entry: string;
  /** Source entry for the static import-graph scan. */
  sourceEntry: string;
  /** The browser bundle must retain `node:crypto` (the randomUUID pin). */
  requiresCrypto: boolean;
  /** Exact set of `node:*` specifiers the source import graph may reach. */
  expectedNodeImports: readonly string[];
}

const probes: Probe[] = [
  {
    name: '@openqueue/core/auth',
    entry: dist('core/dist/auth.js'),
    sourceEntry: dist('core/src/auth.ts'),
    requiresCrypto: false,
    expectedNodeImports: [],
  },
  {
    name: '@openqueue/core/control',
    entry: dist('core/dist/control.js'),
    sourceEntry: dist('core/src/control.ts'),
    requiresCrypto: true,
    expectedNodeImports: ['node:crypto'],
  },
  {
    name: '@openqueue/workbench/control',
    entry: dist('workbench/dist/control.js'),
    sourceEntry: dist('workbench/src/control.ts'),
    requiresCrypto: false,
    expectedNodeImports: [],
  },
];

function dist(relative: string): string {
  return fileURLToPath(new URL(`../packages/${relative}`, import.meta.url));
}

/**
 * Walk the runtime import graph of a source entry and collect the set of
 * `node:*` specifiers reachable through value imports/exports. Type-only
 * statements (`import type …`, `export type …`) are skipped — they are erased at
 * build and never reach the bundle — and package specifiers stop the walk at the
 * package boundary.
 */
async function sourceNodeImports(entry: string): Promise<Set<string>> {
  const node = new Set<string>();
  const seen = new Set<string>();

  const follow = async (from: string, spec: string): Promise<void> => {
    if (spec.startsWith('node:')) {
      node.add(spec);
      return;
    }
    if (!spec.startsWith('.')) return;
    const base = resolve(dirname(from), spec);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
      try {
        await readFile(candidate, 'utf8');
        await visit(candidate);
        return;
      } catch {
        // Not this candidate — try the next extension.
      }
    }
  };

  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    let code: string;
    try {
      code = await readFile(file, 'utf8');
    } catch {
      return;
    }
    const fromRe =
      /(?:^|\n)\s*(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
    for (const match of code.matchAll(fromRe)) {
      if (match[1]) continue; // type-only statement
      await follow(file, match[2]!);
    }
    const sideRe = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
    for (const match of code.matchAll(sideRe)) {
      await follow(file, match[1]!);
    }
  };

  await visit(entry);
  return node;
}

function fail(message: string): never {
  console.error(`[control-gate] ${message}`);
  process.exit(1);
}

async function bundle(
  probe: string,
  target: 'node' | 'browser',
  dir: string,
): Promise<string> {
  const outfile = join(dir, `bundle.${target}.js`);
  try {
    await run('bun', ['build', probe, `--target=${target}`, `--outfile=${outfile}`]);
  } catch (cause) {
    console.error(`[control-gate] failed to bundle for --target=${target}:`);
    console.error(cause);
    process.exit(1);
  }
  return readFile(outfile, 'utf8');
}

/** node builtins referenced by the bundle: bun inlined-polyfill headers plus
 *  any surviving external `node:` imports. */
function nodeBuiltins(code: string): Set<string> {
  const found = new Set<string>();
  const patterns = [
    /\/\/\s*node:([a-z_]+)/g,
    /(?:from|require\()\s*["']node:([a-z_]+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.add(match[1]!);
  }
  return found;
}

const dir = await mkdtemp(join(tmpdir(), 'oq-control-gate-'));
try {
  for (const probe of probes) {
    const source = join(dir, 'probe.mjs');
    await writeFile(
      source,
      `import * as entry from ${JSON.stringify(probe.entry)};\nglobalThis.__keep = entry;\n`,
    );

    const nodeBundle = await bundle(source, 'node', dir);
    const nodeLeaks = ['ioredis', 'bullmq'].filter((mod) =>
      nodeBundle.includes(mod),
    );
    if (nodeLeaks.length > 0) {
      fail(
        `${probe.name} (--target=node) is NOT clean — bundle references: ${nodeLeaks.join(', ')}`,
      );
    }

    const browserBundle = await bundle(source, 'browser', dir);
    const browserLeaks = ['ioredis', 'bullmq'].filter((mod) =>
      browserBundle.includes(mod),
    );
    if (browserLeaks.length > 0) {
      fail(
        `${probe.name} (--target=browser) is NOT clean — bundle references: ${browserLeaks.join(', ')}`,
      );
    }

    const builtins = nodeBuiltins(browserBundle);
    const forbidden = [...builtins].filter(
      (mod) => !ALLOWED_BROWSER_NODE.has(mod),
    );
    if (forbidden.length > 0) {
      fail(
        `${probe.name} (--target=browser) pulls non-edge-safe node builtins: ${forbidden.map((m) => `node:${m}`).join(', ')}`,
      );
    }
    if (probe.requiresCrypto && !builtins.has('crypto')) {
      fail(
        `${probe.name} (--target=browser) is missing node:crypto — the enqueuer's randomUUID must not be swapped for the flag-gated global crypto.randomUUID`,
      );
    }

    // Static source-graph scan — catches builtins bun stubs without a marker.
    const sourceNode = await sourceNodeImports(probe.sourceEntry);
    const expected = new Set(probe.expectedNodeImports);
    const unexpected = [...sourceNode].filter((s) => !expected.has(s)).sort();
    const missing = [...expected].filter((s) => !sourceNode.has(s)).sort();
    if (unexpected.length > 0 || missing.length > 0) {
      const found = [...sourceNode].sort().join(', ') || '∅';
      const want = [...expected].sort().join(', ') || '∅';
      fail(
        `${probe.name} source import graph node:* set drifted — expected {${want}}, found {${found}}` +
          (unexpected.length ? ` [unexpected: ${unexpected.join(', ')}]` : '') +
          (missing.length ? ` [missing: ${missing.join(', ')}]` : ''),
      );
    }

    const surviving = builtins.size === 0 ? 'none' : [...builtins].sort().map((m) => `node:${m}`).join(', ');
    const sourceList = sourceNode.size === 0 ? 'none' : [...sourceNode].sort().join(', ');
    console.log(
      `[control-gate] ${probe.name} is edge-clean (no ioredis/bullmq; browser node builtins: ${surviving}; source node:* graph: ${sourceList})`,
    );
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
