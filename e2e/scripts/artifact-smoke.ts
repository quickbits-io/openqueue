#!/usr/bin/env bun
/**
 * End-to-end smoke for the Nitro artifact: `openqueue build` under Bun, boot
 * the `.output` server under Node, and exercise the real HTTP surface —
 * auth-gated info, catalog tripwire, an enqueue round-trip via the client, the
 * bundled workbench UI, 404 parity with `startWorkerApp`, and a SIGTERM drain
 * of a job that outlasts srvx's 5s graceful-shutdown window.
 */
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@openqueue/client';
import { worldLocal } from '@openqueue/core';
import { defineConfig } from '@openqueue/sdk';
import { startWorkerApp } from '@openqueue/worker';

const TOKEN = 'artifact-smoke';
const HEALTH_DEADLINE_MS = 60_000;
const DRAIN_DEADLINE_MS = 25_000;
const SLEEP_MS = 8_000; // > srvx's 5s graceful window
const POLL_MS = 250;

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const fixtureDir = resolve(scriptDir, '..', 'artifact');
const cliDist = resolve(repoRoot, 'packages', 'cli', 'dist', 'index.js');
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`SMOKE FAIL: ${message}`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolvePort(address.port)
          : reject(new Error('failed to allocate a port')),
      );
    });
  });
}

async function until(
  predicate: () => boolean | Promise<boolean>,
  deadlineMs: number,
): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(POLL_MS);
  }
  return false;
}

function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: (text: string) => void,
): void {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onChunk(decoder.decode(value));
    }
  })();
}

async function main(): Promise<void> {
  // 1. Build the artifact under Bun.
  console.log('[smoke] building artifact…');
  const build = Bun.spawn(
    [process.execPath, cliDist, 'build', '--config', configArg()],
    {
      cwd: repoRoot,
      env: { ...process.env, REDIS_URL },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [buildOut, buildErr, buildCode] = await Promise.all([
    new Response(build.stdout).text(),
    new Response(build.stderr).text(),
    build.exited,
  ]);
  process.stdout.write(buildOut);
  assert(buildCode === 0, `openqueue build failed:\n${buildErr}`);
  // The fixture config statically imports its task, so a census that clears +
  // reimports (or an artifact with the wrong config-import ordering) would print
  // "0 tasks". Assert the boot-check census counted it.
  const summary = `${buildOut}\n${buildErr}`
    .split('\n')
    .find((line) => line.includes('OpenQueue build wrote'));
  assert(
    summary?.includes('wrote 1 tasks') === true,
    `build census should report 1 task, got: ${summary ?? '(no summary)'}`,
  );
  console.log('[smoke] build census reports 1 task');
  const entry = join(fixtureDir, '.output', 'server', 'index.mjs');
  assert(existsSync(entry), `missing artifact entry ${entry}`);

  // 2. Boot the artifact under Node (proves the Node deploy path).
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let out = '';
  const child = Bun.spawn(['node', entry], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      REDIS_URL,
      PORT: String(port),
      NITRO_PORT: String(port),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  pump(child.stdout, (text) => {
    out += text;
    process.stdout.write(text);
  });
  pump(child.stderr, (text) => {
    out += text;
    process.stderr.write(text);
  });

  try {
    const healthy = await until(async () => {
      try {
        return (await fetch(`${url}/health`)).ok;
      } catch {
        return false;
      }
    }, HEALTH_DEADLINE_MS);
    assert(healthy, 'artifact did not become healthy');
    console.log('[smoke] healthy');

    const client = createClient({ host: url, auth: { bearer: TOKEN } });

    // 3. /openqueue/v1 is auth-gated.
    assert(
      (await fetch(`${url}/openqueue/v1/info`)).status === 401,
      'bare /openqueue/v1/info should be 401',
    );
    const info = await client.info();
    assert(info.tasks >= 1, `info.tasks should be >= 1, got ${info.tasks}`);

    // 4. Catalog tripwire — a dual-core-instance artifact publishes 0 tasks.
    const catalog = await client.catalog.read();
    assert(
      catalog.length > 0,
      'catalog is empty (dual-core-instance tripwire)',
    );
    assert(
      catalog.some((e) => e.id === 'echo'),
      'catalog is missing the echo task',
    );
    console.log(`[smoke] info.tasks=${info.tasks}, catalog=${catalog.length}`);

    // 5. Enqueue → completed via the client.
    const { runId } = await client.trigger('echo', { message: 'smoke' });
    const run = await client.runs.poll(runId, {
      pollIntervalMs: 100,
      maxAttempts: 300,
    });
    assert(run.status === 'completed', `run status ${run.status}`);
    console.log('[smoke] enqueue → completed');

    // 6. Workbench SPA + one asset (bundled UI_DIST_PATH resolves).
    const workbench = await fetch(`${url}/workbench/`);
    assert(workbench.status === 200, `/workbench status ${workbench.status}`);
    const assetMatch = (await workbench.text()).match(/assets\/[^"']+/);
    assert(assetMatch, 'no /workbench/assets ref in the served HTML');
    assert(
      (await fetch(`${url}/workbench/${assetMatch[0]}`)).status === 200,
      'workbench asset did not return 200',
    );
    console.log('[smoke] workbench + asset ok');

    // 7. 404 parity: the catch-all delegates unmatched routes to the same h3
    //    app startWorkerApp serves — booted here on worldLocal for a clean ref.
    const reference = await startWorkerApp(
      defineConfig({
        namespace: 'artifact-smoke-ref',
        world: worldLocal(),
        dirs: ['./worker'],
        workbench: { enabled: true },
        api: { token: TOKEN },
      }),
      // The /nope 404 comes from the app's mount fallback and is task-independent,
      // so no tasks are needed to compare the surface.
      { cwd: fixtureDir, port: 0, signals: false, tasks: [] },
    );
    const refOrigin = `http://localhost:${reference.port}`;
    let refStatus: number;
    let refBody: string;
    try {
      const response = await fetch(`${refOrigin}/nope`);
      refStatus = response.status;
      refBody = await response.text();
    } finally {
      await reference.close();
    }
    const artifact404 = await fetch(`${url}/nope`);
    const artifactBody = await artifact404.text();
    // The h3 404 envelope embeds the request origin; normalize it out to compare
    // the shape rather than the (necessarily different) host:port.
    const normalize = (body: string, origin: string) =>
      body.replaceAll(origin, '{origin}');
    assert(
      artifact404.status === refStatus,
      `404 status ${artifact404.status} != ${refStatus}`,
    );
    assert(
      normalize(artifactBody, url) === normalize(refBody, refOrigin),
      `404 envelope differs: ${artifactBody} vs ${refBody}`,
    );
    console.log(`[smoke] 404 parity ok (${refStatus})`);

    // 8. Drain: a job that outlasts srvx's 5s window still completes on SIGTERM.
    const drain = await client.trigger('echo', {
      message: 'drain',
      sleepMs: SLEEP_MS,
    });
    const short = drain.runId.slice(0, 8);
    const started = await until(
      () =>
        out.split('\n').some((l) => l.includes('START') && l.includes(short)),
      10_000,
    );
    assert(started, 'drain job did not start');
    console.log('[smoke] drain job in flight, sending SIGTERM…');
    const sigAt = Date.now();
    child.kill('SIGTERM');
    const exit = await Promise.race([
      child.exited,
      sleep(DRAIN_DEADLINE_MS).then(() => 'timeout' as const),
    ]);
    assert(
      exit !== 'timeout',
      `artifact did not exit within ${DRAIN_DEADLINE_MS / 1000}s of SIGTERM`,
    );
    const drained = out
      .split('\n')
      .some((l) => l.includes('DONE') && l.includes(short));
    assert(
      drained,
      'drain job did not complete during shutdown — srvx 5s grace cut the drain',
    );
    console.log(
      `[smoke] drain ok: job completed, exit=${exit} ${Date.now() - sigAt}ms after SIGTERM`,
    );

    // 9. Source-boot paths must resolve a task-importing config too — the runtime
    //    counterpart of the census fix. Remove the artifact so `start` falls back
    //    to source; `dev-worker` always boots from source.
    await rm(join(fixtureDir, '.output'), { recursive: true, force: true });
    await assertSourceBoot('start');
    await assertSourceBoot('dev-worker');

    console.log('SMOKE PASSED');
  } finally {
    child.kill('SIGKILL');
  }
}

/**
 * Boot the fixture from source via `openqueue <command>` and assert it resolves
 * the task — the config statically imports it, which a clear+reimport or
 * snapshot-delta discovery would drop to zero.
 */
async function assertSourceBoot(
  command: 'start' | 'dev-worker',
): Promise<void> {
  const port = await freePort();
  const worker = Bun.spawn(
    [process.execPath, cliDist, command, '--config', 'worker.config.ts'],
    {
      cwd: fixtureDir,
      env: { ...process.env, REDIS_URL, PORT: String(port) },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  let out = '';
  pump(worker.stdout, (text) => {
    out += text;
  });
  pump(worker.stderr, (text) => {
    out += text;
  });
  try {
    const healthy = await until(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    }, HEALTH_DEADLINE_MS);
    assert(healthy, `${command} source boot did not become healthy:\n${out}`);
    const info = await createClient({
      host: `http://127.0.0.1:${port}`,
      auth: { bearer: TOKEN },
    }).info();
    assert(
      info.tasks >= 1,
      `${command} source boot reported ${info.tasks} tasks (its config statically imports the task)`,
    );
    console.log(`[smoke] ${command} source boot ok: info.tasks=${info.tasks}`);
  } finally {
    worker.kill('SIGTERM');
    await Promise.race([worker.exited, sleep(5_000)]);
    worker.kill('SIGKILL');
  }
}

/** `--config` path relative to the repo root (the CLI resolves it from cwd). */
function configArg(): string {
  return join('e2e', 'artifact', 'worker.config.ts');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
