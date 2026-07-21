#!/usr/bin/env bun
/**
 * Memory soak harness — a MANUAL profiling tool, NOT wired into CI.
 *
 * Boots the worker in-process via `startWorkerApp` (source boot, workbench on —
 * prod parity for a Bun-hosted worker) against the compose Redis (6380) and,
 * optionally, Postgres (5434), then drives four steady-state scenarios and
 * measures memory AFTER a forced GC at each phase boundary. The signal we trust
 * is post-GC RSS / JS-heap drift across a phase, not transient in-phase heap.
 *
 * Scenarios (each on a fresh worker for clean attribution):
 *   a. idle            — workbench enabled, no traffic
 *   b. poll            — hammer the workbench API (overview/queues/runs/…) every 2s
 *   c. load            — enqueue N jobs to completion, then idle; must return to baseline
 *   d. schedules       — a handful of '* * * * *' crons ticking
 *   e. alerts-failures — an alert rule on job_failed + failing jobs (cooldown-map probe)
 *
 * Evidence: per phase we record process.memoryUsage() (rss/heapUsed) plus, under
 * Bun, bun:jsc heapStats (JS heap bytes + a per-constructor live-object
 * histogram). The histogram diff between post-GC baseline and post-GC end names
 * the dominant growing retainers without a Chrome heap diff.
 *
 * Runtime: Bun only (uses Bun.gc + bun:jsc). Full run ~14 min; SOAK_QUICK=1 ~3 min.
 *
 * Usage:
 *   REDIS_URL=redis://localhost:6380 \
 *   DATABASE_URL=postgres://openqueue:openqueue@localhost:5434/openqueue \
 *   bun e2e/scripts/memory-soak.ts            # all scenarios, BullMQ world
 *   SOAK_QUICK=1 bun e2e/scripts/memory-soak.ts
 *   SOAK_ONLY=load,alerts-failures bun e2e/scripts/memory-soak.ts
 *   SOAK_WORLD=postgres bun e2e/scripts/memory-soak.ts
 */
import { heapStats } from 'bun:jsc';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defineConfig,
  getRegisteredTasks,
  type OpenQueueConfig,
  task,
} from '@openqueue/sdk';
import { startWorkerApp } from '@openqueue/worker';
import { worldPostgres } from '@openqueue/world-postgres';
import { z } from 'zod';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const e2eRoot = resolve(scriptDir, '..');

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://openqueue:openqueue@localhost:5434/openqueue';
const WORLD = process.env.SOAK_WORLD === 'postgres' ? 'postgres' : 'bullmq';
const QUICK = process.env.SOAK_QUICK === '1';

const PHASE_MS = num('SOAK_PHASE_MS', QUICK ? 20_000 : 180_000);
const IDLE_AFTER_LOAD_MS = num(
  'SOAK_IDLE_AFTER_LOAD_MS',
  QUICK ? 20_000 : 120_000,
);
const LOAD_JOBS = num('SOAK_LOAD_JOBS', QUICK ? 2_000 : 8_000);
const SAMPLE_MS = num('SOAK_SAMPLE_MS', QUICK ? 2_000 : 5_000);
const DRAIN_DEADLINE_MS = num('SOAK_DRAIN_DEADLINE_MS', 180_000);
const OUT_DIR = process.env.SOAK_OUT ?? resolve(e2eRoot, '.soak-artifacts');

const ONLY = (process.env.SOAK_ONLY ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// ── Tasks ────────────────────────────────────────────────────────────────────
// Registered at module load; passed to startWorkerApp via getRegisteredTasks()
// (the harness pattern — `dirs` discovery yields nothing under a shared graph).
task({
  id: 'soak.echo',
  queue: 'soak',
  schema: z.object({ n: z.number() }),
  concurrency: 25,
  run: async (input) => ({ n: input.n }),
});
task({
  id: 'soak.fail',
  queue: 'soak',
  schema: z.object({ n: z.number() }),
  concurrency: 25,
  attempts: 1,
  run: async () => {
    throw new Error('soak intentional failure');
  },
});

// ── Memory sampling ──────────────────────────────────────────────────────────
const MB = 1024 * 1024;

interface Sample {
  t: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  jscHeap: number;
  jscObjects: number;
}

function sample(): Sample {
  const mem = process.memoryUsage();
  const stats = heapStats();
  return {
    t: Date.now(),
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    jscHeap: stats.heapSize,
    jscObjects: stats.objectCount,
  };
}

async function forceGc(): Promise<void> {
  // Synchronous full GC twice, letting finalizers/weakrefs settle between —
  // a single pass can leave just-unreferenced objects uncollected.
  Bun.gc(true);
  await sleep(150);
  Bun.gc(true);
  await sleep(150);
}

function objectHistogram(): Record<string, number> {
  return { ...heapStats().objectTypeCounts };
}

function diffHistogram(
  before: Record<string, number>,
  after: Record<string, number>,
  top = 15,
): Array<{ ctor: string; before: number; after: number; delta: number }> {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .map((ctor) => {
      const b = before[ctor] ?? 0;
      const a = after[ctor] ?? 0;
      return { ctor, before: b, after: a, delta: a - b };
    })
    .filter((row) => row.delta !== 0)
    .sort((x, y) => y.delta - x.delta)
    .slice(0, top);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

// ── Worker boot ──────────────────────────────────────────────────────────────
type Worker = Awaited<ReturnType<typeof startWorkerApp>>;

function soakConfig(namespace: string): OpenQueueConfig {
  const base = {
    namespace,
    dirs: ['./src/worker'],
    workbench: { enabled: true },
    metrics: { enabled: true },
  };
  return WORLD === 'postgres'
    ? defineConfig({
        ...base,
        world: worldPostgres({ url: DATABASE_URL, migrations: 'auto' }),
      })
    : defineConfig({ ...base, redis: { url: REDIS_URL } });
}

async function boot(namespace: string): Promise<Worker> {
  return startWorkerApp(soakConfig(namespace), {
    cwd: e2eRoot,
    port: 0,
    signals: false,
    tasks: getRegisteredTasks(),
  });
}

// ── Phase runner ─────────────────────────────────────────────────────────────
interface PhaseResult {
  label: string;
  baseline: Sample;
  end: Sample;
  peakRss: number;
  samples: Sample[];
  histDiff: ReturnType<typeof diffHistogram>;
}

/**
 * Settle → GC → baseline; run `during` (a workload) while sampling every
 * SAMPLE_MS for `durationMs`; then GC → end. Growth = end − baseline, post-GC.
 */
async function runPhase(
  label: string,
  durationMs: number,
  during?: (signal: { stopped: boolean }) => void | Promise<void>,
): Promise<PhaseResult> {
  await sleep(1000);
  await forceGc();
  const baseline = sample();
  const beforeHist = objectHistogram();

  const samples: Sample[] = [baseline];
  const signal = { stopped: false };
  const workload = during ? Promise.resolve(during(signal)) : undefined;

  const deadline = Date.now() + durationMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(SAMPLE_MS, Math.max(deadline - Date.now(), 0)));
    samples.push(sample());
  }
  signal.stopped = true;
  await workload;

  await forceGc();
  const end = sample();
  const afterHist = objectHistogram();

  const peakRss = Math.max(...samples.map((s) => s.rss), end.rss);
  const result: PhaseResult = {
    label,
    baseline,
    end,
    peakRss,
    samples,
    histDiff: diffHistogram(beforeHist, afterHist),
  };
  printPhase(result);
  writeFileSync(
    resolve(OUT_DIR, `${label}.json`),
    JSON.stringify(
      {
        label,
        world: WORLD,
        baseline,
        end,
        peakRss,
        deltaRssMb: (end.rss - baseline.rss) / MB,
        deltaHeapUsedMb: (end.heapUsed - baseline.heapUsed) / MB,
        deltaJscHeapMb: (end.jscHeap - baseline.jscHeap) / MB,
        histDiff: result.histDiff,
        samples: samples.map((s) => ({
          dt: Math.round((s.t - baseline.t) / 1000),
          rssMb: +(s.rss / MB).toFixed(1),
          heapUsedMb: +(s.heapUsed / MB).toFixed(1),
          jscHeapMb: +(s.jscHeap / MB).toFixed(1),
        })),
      },
      null,
      2,
    ),
  );
  return result;
}

function printPhase(r: PhaseResult): void {
  const dRss = (r.end.rss - r.baseline.rss) / MB;
  const dHeap = (r.end.heapUsed - r.baseline.heapUsed) / MB;
  const dJsc = (r.end.jscHeap - r.baseline.jscHeap) / MB;
  const dObj = r.end.jscObjects - r.baseline.jscObjects;
  console.log(`\n──── ${r.label} (post-GC) ────`);
  console.log(
    `  RSS      base ${mb(r.baseline.rss)}  end ${mb(r.end.rss)}  peak ${mb(
      r.peakRss,
    )}  Δ ${signed(dRss)} MB`,
  );
  console.log(
    `  heapUsed base ${mb(r.baseline.heapUsed)}  end ${mb(
      r.end.heapUsed,
    )}  Δ ${signed(dHeap)} MB`,
  );
  console.log(
    `  jscHeap  base ${mb(r.baseline.jscHeap)}  end ${mb(
      r.end.jscHeap,
    )}  Δ ${signed(dJsc)} MB   objects Δ ${signed(dObj, 0)}`,
  );
  if (r.histDiff.length > 0) {
    console.log('  top live-object growth (constructor: Δcount):');
    for (const row of r.histDiff.slice(0, 8)) {
      console.log(
        `    ${row.ctor.padEnd(30)} ${signed(row.delta, 0)}  (${row.before} → ${row.after})`,
      );
    }
  }
}

const mb = (bytes: number): string => `${(bytes / MB).toFixed(1)}MB`;
const signed = (n: number, digits = 2): string =>
  `${n >= 0 ? '+' : ''}${n.toFixed(digits)}`;

// ── Workloads ────────────────────────────────────────────────────────────────
function pollWorkbench(url: string, everyMs: number) {
  const paths = [
    '/workbench/api/overview',
    '/workbench/api/queues',
    '/workbench/api/queue-names',
    '/workbench/api/runs?limit=50',
    '/workbench/api/metrics',
    '/workbench/api/activity',
    '/metrics',
  ];
  return async (signal: { stopped: boolean }) => {
    let polls = 0;
    while (!signal.stopped) {
      await Promise.allSettled(
        paths.map((p) => fetch(`${url}${p}`).then((r) => r.arrayBuffer())),
      );
      polls++;
      await sleep(everyMs);
    }
    console.log(`  [poll] completed ${polls} poll rounds`);
  };
}

function parseDepth(metricsText: string): number {
  let depth = 0;
  for (const line of metricsText.split('\n')) {
    const m = line.match(
      /openqueue_worker_queue_jobs\{[^}]*status="(waiting|active|prioritized|delayed)"\}\s+(\d+)/,
    );
    if (m) depth += Number(m[2]);
  }
  return depth;
}

async function drainQueue(url: string, deadlineMs: number): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  let depth = Number.POSITIVE_INFINITY;
  while (Date.now() < deadline) {
    const text = await fetch(`${url}/metrics`).then((r) => r.text());
    depth = parseDepth(text);
    if (depth === 0) return 0;
    await sleep(500);
  }
  return depth;
}

// ── Scenarios ────────────────────────────────────────────────────────────────
async function scenarioIdle(): Promise<void> {
  const worker = await boot(`soak-idle-${Date.now()}`);
  try {
    await runPhase('idle', PHASE_MS);
  } finally {
    await worker.close();
  }
}

async function scenarioPoll(): Promise<void> {
  const worker = await boot(`soak-poll-${Date.now()}`);
  try {
    await runPhase('poll', PHASE_MS, pollWorkbench(url(worker), 2000));
  } finally {
    await worker.close();
  }
}

async function scenarioLoad(): Promise<void> {
  const worker = await boot(`soak-load-${Date.now()}`);
  try {
    await sleep(1000);
    await forceGc();
    const baseline = sample();
    const beforeHist = objectHistogram();
    console.log(`\n──── load: enqueuing ${LOAD_JOBS} jobs ────`);

    const enqStart = Date.now();
    // Enqueue in bounded-concurrency batches to avoid a huge promise fan-out.
    const batch = 200;
    for (let i = 0; i < LOAD_JOBS; i += batch) {
      const slice = Array.from(
        { length: Math.min(batch, LOAD_JOBS - i) },
        (_, k) => worker.runtime.trigger('soak.echo', { n: i + k }),
      );
      await Promise.all(slice);
    }
    console.log(
      `  enqueued in ${((Date.now() - enqStart) / 1000).toFixed(1)}s`,
    );

    const peakDuringLoad: Sample[] = [];
    const drainSignal = { done: false };
    void (async () => {
      while (!drainSignal.done) {
        peakDuringLoad.push(sample());
        await sleep(SAMPLE_MS);
      }
    })();

    const leftover = await drainQueue(url(worker), DRAIN_DEADLINE_MS);
    drainSignal.done = true;
    console.log(
      leftover === 0
        ? `  drained to empty in ${((Date.now() - enqStart) / 1000).toFixed(1)}s`
        : `  WARN: ${leftover} jobs still queued at drain deadline`,
    );

    // Idle after load, then judge return-to-baseline post-GC.
    const idleEnd = Date.now() + IDLE_AFTER_LOAD_MS;
    while (Date.now() < idleEnd) {
      peakDuringLoad.push(sample());
      await sleep(SAMPLE_MS);
    }

    await forceGc();
    const end = sample();
    const afterHist = objectHistogram();
    const peakRss = Math.max(...peakDuringLoad.map((s) => s.rss), end.rss);
    printPhase({
      label: 'load',
      baseline,
      end,
      peakRss,
      samples: [baseline, ...peakDuringLoad, end],
      histDiff: diffHistogram(beforeHist, afterHist),
    });
    writeFileSync(
      resolve(OUT_DIR, 'load.json'),
      JSON.stringify(
        {
          label: 'load',
          world: WORLD,
          jobs: LOAD_JOBS,
          baseline,
          end,
          peakRss,
          deltaRssMb: (end.rss - baseline.rss) / MB,
          deltaHeapUsedMb: (end.heapUsed - baseline.heapUsed) / MB,
          deltaJscHeapMb: (end.jscHeap - baseline.jscHeap) / MB,
          histDiff: diffHistogram(beforeHist, afterHist),
        },
        null,
        2,
      ),
    );
  } finally {
    await worker.close();
  }
}

async function scenarioSchedules(): Promise<void> {
  const worker = await boot(`soak-sched-${Date.now()}`);
  try {
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        worker.runtime.schedules.create({
          task: 'soak.echo',
          cron: '* * * * *',
          input: { n: i },
          deduplicationKey: `soak-sched-${i}`,
        }),
      ),
    );
    console.log(`\n──── schedules: created ${created.length} crons ────`);
    await runPhase('schedules', PHASE_MS);
    await Promise.all(
      created.map((s) => worker.runtime.schedules.delete(s.id).catch(() => {})),
    );
  } finally {
    await worker.close();
  }
}

async function scenarioAlertsFailures(): Promise<void> {
  const worker = await boot(`soak-alerts-${Date.now()}`);
  try {
    // Seed a job_failed alert rule via the workbench API so the alert manager's
    // QueueEvents 'failed' handler exercises the per-job cooldown path.
    const created = await fetch(`${url(worker)}/workbench/api/alerts/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'soak-failed',
        enabled: true,
        trigger: 'job_failed',
        severity: 'warning',
        queues: ['soak'],
        // Schema requires ≥1 id; a non-existent one still fires the rule (and
        // populates cooldowns) while delivering to no contact point.
        contactPointIds: ['soak-probe'],
      }),
    });
    console.log(`\n──── alerts-failures: rule POST → ${created.status} ────`);

    await sleep(1000);
    await forceGc();
    const baseline = sample();
    const beforeHist = objectHistogram();

    // Fire distinct failing jobs; each unique jobId mints a cooldown fingerprint.
    // Push past the cooldown cap (default 10k) to make the bound observable.
    const failJobs = QUICK ? 2_000 : LOAD_JOBS;
    console.log(`  enqueuing ${failJobs} failing jobs`);
    const batch = 200;
    for (let i = 0; i < failJobs; i += batch) {
      const slice = Array.from(
        { length: Math.min(batch, failJobs - i) },
        (_, k) => worker.runtime.trigger('soak.fail', { n: i + k }),
      );
      await Promise.all(slice);
    }

    const leftover = await drainQueue(url(worker), DRAIN_DEADLINE_MS);
    console.log(
      leftover === 0
        ? '  all failing jobs processed'
        : `  WARN: ${leftover} jobs still queued`,
    );
    // Let the QueueEvents 'failed' stream drain: it delivers each event and does
    // a getJob per event, so wait until the cooldown fill stops moving the heap
    // (three flat samples) rather than a fixed guess.
    const deliverDeadline = Date.now() + (QUICK ? 15_000 : 90_000);
    let flat = 0;
    let prevHeap = sample().heapUsed;
    while (Date.now() < deliverDeadline && flat < 3) {
      await sleep(3000);
      const h = sample().heapUsed;
      flat = Math.abs(h - prevHeap) < 256 * 1024 ? flat + 1 : 0;
      prevHeap = h;
    }

    await forceGc();
    const end = sample();
    const afterHist = objectHistogram();
    printPhase({
      label: 'alerts-failures',
      baseline,
      end,
      peakRss: Math.max(baseline.rss, end.rss),
      samples: [baseline, end],
      histDiff: diffHistogram(beforeHist, afterHist),
    });
    writeFileSync(
      resolve(OUT_DIR, 'alerts-failures.json'),
      JSON.stringify(
        {
          label: 'alerts-failures',
          world: WORLD,
          failJobs,
          baseline,
          end,
          deltaRssMb: (end.rss - baseline.rss) / MB,
          deltaHeapUsedMb: (end.heapUsed - baseline.heapUsed) / MB,
          deltaJscHeapMb: (end.jscHeap - baseline.jscHeap) / MB,
          histDiff: diffHistogram(beforeHist, afterHist, 25),
        },
        null,
        2,
      ),
    );
  } finally {
    await worker.close();
  }
}

const url = (w: Worker): string => `http://localhost:${w.port}`;

// ── Main ─────────────────────────────────────────────────────────────────────
const scenarios: Record<string, () => Promise<void>> = {
  idle: scenarioIdle,
  poll: scenarioPoll,
  load: scenarioLoad,
  schedules: scenarioSchedules,
  'alerts-failures': scenarioAlertsFailures,
};

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const selected =
    ONLY.length > 0
      ? ONLY.filter((name) => name in scenarios)
      : Object.keys(scenarios);
  console.log(
    `[soak] world=${WORLD} quick=${QUICK} phase=${PHASE_MS}ms load=${LOAD_JOBS} out=${OUT_DIR}`,
  );
  console.log(`[soak] scenarios: ${selected.join(', ')}`);
  for (const name of selected) {
    console.log(`\n================ scenario: ${name} ================`);
    await scenarios[name]!();
  }
  console.log('\n[soak] done');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
