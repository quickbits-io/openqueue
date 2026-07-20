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

async function runArtifact(entry: string, cwd: string): Promise<void> {
  const port = Number(process.env.PORT ?? 8090);
  const child = Bun.spawn([process.execPath, entry], {
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
