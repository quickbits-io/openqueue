import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OpenQueueConfig } from '@openqueue/core';
import { startWorkerApp } from '@openqueue/worker';
import { loadDirectTasks } from './tasks';

const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_TIMEOUT_MS = 60_000;

/**
 * Run the built Nitro artifact when present, else boot from source. Spawns
 * `<outDir>/server/index.mjs` under the current runtime with the worker's
 * default port injected, polls `/health` until ready, and forwards signals.
 */
export async function start(
  config: OpenQueueConfig,
  cwd: string,
): Promise<void> {
  const entry = resolve(
    cwd,
    config.build?.outDir ?? '.output',
    'server',
    'index.mjs',
  );
  if (!existsSync(entry)) {
    await startFromSource(config, cwd, { direct: false });
    return;
  }
  await runArtifact(entry, cwd);
}

/**
 * In-process source boot — the `dev-worker` command and the no-artifact
 * fallback of `start`. `direct` discovers and passes the tasks explicitly (the
 * reliable path when the worker is re-spawned on change); otherwise the worker
 * resolves them from `dirs`/`tasks`.
 */
export async function startFromSource(
  config: OpenQueueConfig,
  cwd: string,
  options: { direct: boolean },
): Promise<void> {
  await startWorkerApp(config, {
    cwd,
    tasks: options.direct ? await loadDirectTasks(config, cwd) : undefined,
  });
}

/** The worker's default port, or a validated `PORT`. Fails fast on garbage so a
 *  non-numeric value can't silently become `NITRO_PORT=NaN` + a 60s poll to
 *  nowhere. */
function resolvePort(): number {
  const raw = process.env.PORT;
  if (raw === undefined || raw.trim() === '') return 8090;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(
      `Invalid PORT "${raw}": expected an integer between 0 and 65535.`,
    );
  }
  return parsed;
}

/**
 * The Nitro node-server bundle's runtime floor: `^20.19 || >=22.12` (Bun also
 * runs it). True when a `node --version` string satisfies that range. Exported
 * for testing. `21.x` and `22.0–22.11` fall in the gap between the two ranges.
 */
export function satisfiesNodeFloor(version: string): boolean {
  const match = version.trim().match(/^v?(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 20) return minor >= 19;
  if (major === 22) return minor >= 12;
  return major >= 23;
}

/**
 * A PATH `node` that meets the artifact floor, or `null`. The CLI runs on Bun,
 * so `process.execPath` is the Bun binary — but the artifact is a Node bundle,
 * and Bun's node-compat carries a heavier RSS profile. Prefer real Node when it
 * is present and new enough; ignore an absent or too-old one.
 */
function resolveNodeRuntime(): { path: string; version: string } | null {
  const path = Bun.which('node');
  if (!path) return null;
  try {
    const probe = Bun.spawnSync([path, '--version']);
    if (!probe.success) return null;
    const version = probe.stdout.toString().trim();
    return satisfiesNodeFloor(version) ? { path, version } : null;
  } catch {
    return null;
  }
}

async function runArtifact(entry: string, cwd: string): Promise<void> {
  const port = resolvePort();
  const node = resolveNodeRuntime();
  const runtimeBin = node?.path ?? process.execPath;
  console.log(
    node
      ? `[openqueue] artifact runtime: Node ${node.version} (${node.path})`
      : `[openqueue] artifact runtime: Bun (${process.execPath}) — no Node ^20.19 || >=22.12 on PATH`,
  );
  const child = Bun.spawn([runtimeBin, entry], {
    cwd,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
    env: { ...process.env, PORT: String(port), NITRO_PORT: String(port) },
  });

  // Forward the first SIGTERM/SIGINT to the child; a drain may take minutes, so
  // there is no timed SIGKILL — the platform's grace period owns that bound. A
  // second signal escalates to SIGKILL.
  let forwarded = false;
  const forward = (signal: 'SIGTERM' | 'SIGINT') => {
    child.kill(forwarded ? 'SIGKILL' : signal);
    forwarded = true;
  };
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));

  if (!(await pollHealth(port, child))) {
    child.kill('SIGKILL');
    console.error(
      `[openqueue] artifact did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s`,
    );
    process.exit(1);
  }
  console.log(`[openqueue] worker ready on :${port}`);

  process.exit(await child.exited);
}

async function pollHealth(
  port: number,
  child: Bun.Subprocess,
): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return true;
    } catch {
      // Not accepting connections yet — keep polling.
    }
    await Bun.sleep(HEALTH_POLL_INTERVAL_MS);
  }
  return false;
}
