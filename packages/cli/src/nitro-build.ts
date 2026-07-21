import { existsSync } from 'node:fs';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { OpenQueueConfig } from '@openqueue/core';
import { discoverTaskFiles } from './tasks';

interface BootTaskReport {
  id: string;
  queue: string;
  cron: string | null;
}

const BOOT_REPORT_MARKER = '__openqueue_boot_report__';

/**
 * Every publishable `@openqueue/*` package. Nitro bundles the framework into
 * the server (rolldown dedups `@openqueue/core` to one instance, so the task
 * registry stays a single shared singleton). This list drives (a) linking the
 * packages so rolldown can resolve them and (b) locating the workbench UI.
 */
const OPENQUEUE_PACKAGES = [
  '@openqueue/core',
  '@openqueue/sdk',
  '@openqueue/client',
  '@openqueue/world-bullmq',
  '@openqueue/world-postgres',
  '@openqueue/worker',
  '@openqueue/workbench',
  '@openqueue/cli',
] as const;

/**
 * Compile the worker into a self-contained Nitro node-server artifact under
 * `config.build.outDir` (default `.output`). The artifact hosts the same h3 app
 * the embedded worker serves, via a generated boot plugin + a `/**` catch-all.
 */
export async function build(
  config: OpenQueueConfig,
  cwd: string,
  configPath: string,
): Promise<void> {
  const taskFiles = await discoverTaskFiles(config, cwd);
  if (taskFiles.length === 0) {
    throw new Error('OpenQueue build found no task files');
  }

  // The boot plugin lives outside Nitro's buildDir, which prepare() cleans.
  const generatedDir = resolve(cwd, '.openqueue', 'generated');
  const bootPath = join(generatedDir, 'boot.mjs');
  await mkdir(generatedDir, { recursive: true });
  await writeFile(bootPath, bootSource(taskFiles, cwd, configPath, bootPath));

  const outDir = resolve(cwd, config.build?.outDir ?? '.output');
  const packageDirs = resolveOpenqueuePackages(cwd);
  // Isolated installs (bun workspaces, pnpm) do not hoist transitive
  // `@openqueue/*` into the app's node_modules, so rolldown cannot resolve them
  // to bundle. Link the missing ones for the duration of the build — a hoisted
  // install already resolves them, so this is a no-op there. Once bundled, the
  // artifact carries them inline; the links are removed afterward.
  const links = await linkWorkspacePackages(cwd, packageDirs);
  let report: BootTaskReport[];
  try {
    // Validate the build by executing the generated boot module in a fresh
    // subprocess — the exact code path (and ordering) the artifact runs, so the
    // census is correct no matter what the config imports. Dup ids, load errors,
    // and config errors throw at module top level → non-zero exit → build fails.
    report = await runBootCheck(bootPath, cwd);

    const {
      build: buildNitro,
      copyPublicAssets,
      createNitro,
      prepare,
    } = await import('nitro/builder');
    const nitro = await createNitro({
      _cli: { command: 'build' },
      // Force the node-server preset: the CLI runs under Bun, whose default
      // preset would emit a Bun-only bundle; node-server runs on Node and Bun.
      preset: 'node-server',
      rootDir: cwd,
      buildDir: resolve(cwd, '.openqueue', 'nitro'),
      output: { dir: outDir },
      dev: false,
      // Flows into the rolldown output; Nitro's production default is off.
      sourcemap: config.build?.sourcemap ?? false,
      serverDir: false,
      scanDirs: [],
      publicAssets: [],
      features: { websocket: false },
      plugins: [bootPath],
      // Keep author-declared heavy deps out of the bundle: externalize-and-trace
      // them into server/node_modules. `traceDeps` is an include allowlist, so an
      // empty/absent list bundles everything (the framework included, deduped to
      // one @openqueue/core). Regular npm deps resolve to a `node_modules/<name>`
      // path that Nitro's path-matching honors; symlinked workspace packages do
      // not (their realpath loses the name), which is why the framework is bundled.
      traceDeps: config.build?.external,
    });
    // One catch-all delegating every request to the same h3 app the embedded
    // worker serves — the artifact's HTTP surface is the same code by construction.
    nitro.options.handlers.push({
      route: '/**',
      handler: '#openqueue/worker-route',
    });
    nitro.options.virtual['#openqueue/worker-route'] =
      "import { nitroWorkerFetch } from '@openqueue/worker/nitro';\nexport default (event) => nitroWorkerFetch(event.req);";
    nitro.routing.sync();

    await prepare(nitro);
    await copyPublicAssets(nitro);
    await buildNitro(nitro);
    await nitro.close();
  } finally {
    await Promise.all(links.map((link) => rm(link, { force: true })));
  }

  await copyWorkbenchUi(packageDirs.get('@openqueue/workbench'), outDir);
  await copyExtraFiles(config.build?.extraFiles ?? [], cwd, outDir);

  const queues = new Set(report.map((task) => task.queue));
  const schedules = report.filter((task) => task.cron !== null).length;
  const size = await directorySize(outDir);
  console.log(
    `OpenQueue build wrote ${report.length} tasks, ${queues.size} queues, ${schedules} schedules, ${formatBytes(size)} to ${outDir}`,
  );
}

/**
 * Execute the generated boot module in a fresh subprocess under the current
 * runtime (Bun compiles the config + task TS). In check mode it clears the
 * registry, imports the task files, snapshots, imports the config, then reports
 * the census and exits — without booting anything. A validation failure exits
 * non-zero and its output is surfaced.
 */
async function runBootCheck(
  bootPath: string,
  cwd: string,
): Promise<BootTaskReport[]> {
  const child = Bun.spawn([process.execPath, bootPath], {
    cwd,
    env: { ...process.env, OPENQUEUE_BOOT_CHECK: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `OpenQueue build failed while validating tasks:\n${(stderr || stdout).trim()}`,
    );
  }
  const line = stdout
    .split('\n')
    .find((entry) => entry.startsWith(BOOT_REPORT_MARKER));
  if (line === undefined) {
    throw new Error(
      `OpenQueue build produced no task report:\n${(stdout + stderr).trim()}`,
    );
  }
  const report: BootTaskReport[] = JSON.parse(
    line.slice(BOOT_REPORT_MARKER.length),
  );
  return report;
}

/**
 * Locate the real directory of every reachable `@openqueue/*` package. Starts
 * from the app and follows the resolution chain through each package it finds,
 * so transitively-depended packages (not resolvable from the app root in an
 * isolated install) are still discovered.
 */
function resolveOpenqueuePackages(cwd: string): Map<string, string> {
  const dirs = new Map<string, string>();
  const bases = [join(cwd, 'package.json')];
  const seen = new Set<string>();

  while (bases.length > 0) {
    const base = bases.shift();
    if (base === undefined || seen.has(base)) continue;
    seen.add(base);

    let require: ReturnType<typeof createRequire>;
    try {
      require = createRequire(base);
    } catch {
      continue;
    }
    for (const name of OPENQUEUE_PACKAGES) {
      if (dirs.has(name)) continue;
      try {
        const manifest = require.resolve(`${name}/package.json`);
        dirs.set(name, dirname(manifest));
        bases.push(manifest);
      } catch {
        // Not reachable from this base; another base may still resolve it.
      }
    }
  }
  return dirs;
}

/**
 * Symlink any `@openqueue/*` package that is not already resolvable from the
 * app root into its node_modules, so rolldown resolves and bundles them.
 * Returns the links created, for cleanup after the build.
 */
async function linkWorkspacePackages(
  cwd: string,
  packageDirs: Map<string, string>,
): Promise<string[]> {
  const require = createRequire(join(cwd, 'package.json'));
  const created: string[] = [];
  for (const [name, dir] of packageDirs) {
    try {
      require.resolve(`${name}/package.json`);
      continue;
    } catch {
      // Not resolvable from the app root — link it below.
    }
    const linkPath = join(cwd, 'node_modules', ...name.split('/'));
    if (existsSync(linkPath)) continue;
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(dir, linkPath, 'dir');
    created.push(linkPath);
  }
  return created;
}

/**
 * Render the generated boot plugin. Ordering is load-bearing: clear the
 * registry, import each task file (in discovery order) to repopulate it,
 * snapshot the tasks, then import the config *dynamically* — a static config
 * import hoists above `clearRegisteredTasks()`, and a config graph that touches
 * task files would leave the snapshot empty.
 */
function bootSource(
  files: string[],
  cwd: string,
  configPath: string,
  bootPath: string,
): string {
  const bootDir = dirname(bootPath);
  const blocks = files
    .map((file) => {
      const label = JSON.stringify(relative(cwd, file).replaceAll('\\', '/'));
      const specifier = JSON.stringify(importSpecifier(bootDir, file));
      return `setTaskDiscoveryContext(${label});
try {
  await import(${specifier});
} finally {
  clearTaskDiscoveryContext();
}`;
    })
    .join('\n');
  const configSpecifier = JSON.stringify(importSpecifier(bootDir, configPath));

  return `// Generated by openqueue build. Do not edit.
import {
  clearRegisteredTasks,
  clearTaskDiscoveryContext,
  getRegisteredTasks,
  setTaskDiscoveryContext,
  validateTaskDefinitions,
} from '@openqueue/core';
import { createNitroWorkerPlugin } from '@openqueue/worker/nitro';

clearRegisteredTasks();
${blocks}

const tasks = validateTaskDefinitions(getRegisteredTasks());
// Imported after the snapshot, dynamically: see bootSource() in nitro-build.ts.
const { default: config } = await import(${configSpecifier});

// Build-check mode (openqueue build): the task snapshot and the config import are
// both exercised above, so this reports the true census and exits before the
// plugin is created. Never set in the artifact.
if (process.env.OPENQUEUE_BOOT_CHECK) {
  console.log(
    ${JSON.stringify(BOOT_REPORT_MARKER)} +
      JSON.stringify(
        tasks.map((task) => ({
          id: task.id,
          queue: task.queue,
          cron: task.cron ?? null,
        })),
      ),
  );
  process.exit(0);
}

export default createNitroWorkerPlugin({ config, tasks });
`;
}

function importSpecifier(fromDir: string, target: string): string {
  const rel = relative(fromDir, target).replaceAll('\\', '/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/**
 * Copy the workbench's `dist/ui` (index.html + assets) into the bundled
 * artifact. The workbench is bundled, so its `import.meta.url`-relative
 * `UI_DIST_PATH` resolves to `<out>/dist/ui` (ui-dist in `server/index.mjs`) or
 * `<out>/server/dist/ui` (ui-dist in a `server/_libs` chunk); populate both.
 * Idempotent.
 */
async function copyWorkbenchUi(
  workbenchDir: string | undefined,
  outDir: string,
): Promise<void> {
  if (workbenchDir === undefined) return;
  const source = join(workbenchDir, 'dist', 'ui');
  if (!existsSync(source)) return;
  for (const target of [
    join(outDir, 'dist', 'ui'),
    join(outDir, 'server', 'dist', 'ui'),
  ]) {
    if (existsSync(target)) continue;
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}

/**
 * Copy `config.build.extraFiles` (runtime assets the config promises to include)
 * into the artifact, preserving each entry's path relative to the project root.
 * A listed file that does not exist fails the build rather than silently
 * shipping an artifact missing it.
 */
export async function copyExtraFiles(
  entries: string[],
  cwd: string,
  outDir: string,
): Promise<void> {
  for (const entry of entries) {
    const source = resolve(cwd, entry);
    const rel = relative(cwd, source);
    // An absolute path or a `../` entry escapes the artifact: `join(outDir, rel)`
    // would land the copy outside `.output` (silently missing from the artifact,
    // and possibly clobbering a sibling path). Only files under the project root
    // preserve a safe relative target.
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `OpenQueue build: build.extraFiles entry "${entry}" resolves outside the project root; only files under it can be copied into the artifact`,
      );
    }
    if (!existsSync(source)) {
      throw new Error(
        `OpenQueue build: build.extraFiles entry "${entry}" does not exist`,
      );
    }
    const target = join(outDir, rel);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}

async function directorySize(dir: string): Promise<number> {
  if (!existsSync(dir)) return 0;
  const files = await Array.fromAsync(
    new Bun.Glob('**/*').scan({ cwd: dir, absolute: true }),
  );
  let total = 0;
  for (const file of files) {
    total += Bun.file(file).size;
  }
  return total;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}
