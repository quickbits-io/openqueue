import { existsSync } from 'node:fs';
import { cp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import type { OpenQueueConfig } from '@openqueue/core';
import { discoverTaskFiles, loadTasksFromFiles } from './tasks';

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

  // Fail fast: import + validate the task graph in-process so duplicate ids and
  // load errors surface here, before the (much slower) Nitro build.
  const tasks = await loadTasksFromFiles(taskFiles, cwd);

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
  try {
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
      serverDir: false,
      scanDirs: [],
      publicAssets: [],
      features: { websocket: false },
      plugins: [bootPath],
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

  const queues = new Set(tasks.map((task) => task.queue));
  const schedules = tasks.filter((task) => task.cron).length;
  const size = await directorySize(outDir);
  console.log(
    `OpenQueue build wrote ${tasks.length} tasks, ${queues.size} queues, ${schedules} schedules, ${formatBytes(size)} to ${outDir}`,
  );
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
