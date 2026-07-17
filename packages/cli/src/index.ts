#!/usr/bin/env bun

import { existsSync, watch } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  OpenQueueConfig,
  QueueConfigTaskModule,
  QueueTaskDiscovery,
  TaskDefinition,
  WorldMigrationStep,
} from '@openqueue/core';
import {
  clearRegisteredTasks,
  clearTaskDiscoveryContext,
  defaultTaskDiscoveryExclude,
  getRegisteredTasks,
  resolveNamespace,
  setTaskDiscoveryContext,
  sortTaskFiles,
  validateTaskDefinitions,
} from '@openqueue/core';
import { loadConfig, startWorkerApp } from '@openqueue/worker';

const [, , command = 'help', ...args] = process.argv;
const QUEUE_SCHEMA_FILE = 'src/queue-schema.ts';

try {
  if (command === 'init') {
    await init();
  } else if (command === 'add') {
    await add(args[0]);
  } else if (command === 'dev') {
    await dev();
  } else if (command === 'dev-worker') {
    await start({ preferManifest: false });
  } else if (command === 'start') {
    await start({ preferManifest: true });
  } else if (command === 'build') {
    await build();
    process.exit(0);
  } else if (command === 'migrations') {
    await migrations();
  } else {
    help();
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

async function init(): Promise<void> {
  await writeIfMissing(
    'worker.config.ts',
    `import { defineConfig } from '@openqueue/sdk';

export default defineConfig({
  namespace: process.env.OPENQUEUE_NAMESPACE ?? 'my-app',
  dirs: ['./worker'],
  redis: { url: process.env.REDIS_URL! },
  concurrency: {
    global: 8,
  },
  workbench: {
    enabled: true,
    title: 'Jobs',
    basePath: '/workbench',
  },
});
`,
  );
  await writeIfMissing(
    '.env',
    `REDIS_URL=redis://localhost:6379
PORT=8090
OPENQUEUE_NAMESPACE=my-app
`,
  );
  await writeIfMissing(
    '.env.example',
    `REDIS_URL=redis://localhost:6379
PORT=8090
OPENQUEUE_NAMESPACE=my-app
`,
  );
  await writeIfMissing('Dockerfile', await dockerfileTemplate());
  await writeIfMissing(
    'worker/example.ts',
    `import { task } from '@openqueue/sdk';
import { z } from 'zod';

export const exampleTask = task({
  id: 'example',
  schema: z.object({
    message: z.string().default('Hello from OpenQueue'),
  }),
  run: async (payload, ctx) => {
    ctx.logger.info('received message', { message: payload.message });
    await ctx.progress({ step: 'done' });
    return { ok: true };
  },
});
`,
  );
  await updatePackageJson();
  console.log('OpenQueue initialized');
}

async function add(feature: string | undefined): Promise<void> {
  if (feature === 'persistence') {
    await addPersistence();
    return;
  }
  console.error(
    `${feature ? `Unknown feature "${feature}"` : 'Usage: openqueue add <feature>'}

Available features:
  persistence  Postgres run history, schedules, and alerts via Drizzle`,
  );
  process.exit(1);
}

async function addPersistence(): Promise<void> {
  const wroteSchema = await writeIfMissing(
    QUEUE_SCHEMA_FILE,
    `import { defineQueueSchema } from '@openqueue/sdk';

export const queueSchema = defineQueueSchema({ schema: 'jobs' });

export const {
  queueCatalog,
  queueSchedules,
  queueScheduleInstances,
  queueRuns,
  queueRunEvents,
  alertChannels,
  alertRules,
} = queueSchema;
`,
  );
  console.log(
    wroteSchema
      ? `created ${QUEUE_SCHEMA_FILE}`
      : `${QUEUE_SCHEMA_FILE} already exists, left untouched`,
  );

  const existingDrizzleConfig = [
    'drizzle.config.ts',
    'drizzle.config.js',
    'drizzle.config.mjs',
  ].find((path) => existsSync(path));
  if (existingDrizzleConfig) {
    const source = await readFile(existingDrizzleConfig, 'utf8');
    const hint = source.includes('queue-schema')
      ? ''
      : `\n  add './${QUEUE_SCHEMA_FILE}' to its schema files and 'jobs' to schemaFilter`;
    console.log(
      `${existingDrizzleConfig} already exists, left untouched${hint}`,
    );
  } else {
    await writeIfMissing(
      'drizzle.config.ts',
      `import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './${QUEUE_SCHEMA_FILE}',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
  schemaFilter: ['jobs'],
  migrations: {
    table: '__drizzle_migrations',
    schema: 'jobs',
  },
});
`,
    );
    console.log('created drizzle.config.ts');
  }

  const added = await addDependencies({
    dependencies: { 'drizzle-orm': '^0.45.1' },
    devDependencies: { 'drizzle-kit': '^0.31.10' },
  });
  if (added === null) {
    console.log(
      'no package.json found — add drizzle-orm and drizzle-kit yourself',
    );
  } else if (added.length > 0) {
    console.log(`added ${added.join(', ')} to package.json — run bun install`);
  } else {
    console.log('drizzle-orm and drizzle-kit already in package.json');
  }

  const configFile = configPath();
  const configSource = existsSync(configFile)
    ? await readFile(configFile, 'utf8')
    : null;
  if (configSource && /\bstorage\s*:/.test(configSource)) {
    console.log(`storage already configured in ${configFile}`);
  } else {
    console.log(`
Wire the adapter into your worker config:

  import { defineConfig, postgresAdapter } from '@openqueue/sdk';
  import { db } from './src/db';
  import { queueSchema } from './src/queue-schema';

  export default defineConfig({
    // …
    storage: {
      adapter: postgresAdapter({ db, schema: queueSchema }),
    },
  });

\`db\` is your Drizzle database instance.`);
  }

  console.log(`
Then generate and run the migrations:

  bunx drizzle-kit generate
  bunx drizzle-kit migrate

Docs: https://openqueue.dev/docs/persistence`);
}

async function start(options: { preferManifest: boolean }): Promise<void> {
  const { config, cwd } = await loadCliConfig();
  await startWorkerApp(config, {
    cwd,
    tasks: options.preferManifest
      ? undefined
      : await loadDirectTasks(config, cwd),
  });
}

async function migrations(): Promise<void> {
  const sub = args.find((arg) => arg === 'print' || arg === 'status');
  if (!sub) {
    console.error('Usage: openqueue migrations <print|status>');
    process.exit(1);
  }

  const { config } = await loadCliConfig();
  if (!config.world) {
    throw new Error(
      'OpenQueue migrations require a world-backed config (config.world), e.g. worldPostgres from @openqueue/world-postgres. Redis-backed workers have no migrations.',
    );
  }

  const world = await config.world({
    namespace: resolveNamespace({ namespace: config.namespace }).namespace,
  });
  try {
    if (!world.migrations) {
      throw new Error(
        `OpenQueue world (transport "${world.transport.id}") does not expose migrations.`,
      );
    }

    if (sub === 'print') {
      console.log(assembleMigrationScript(world.migrations.steps));
      return;
    }

    const statuses = await world.migrations.status();
    let mismatch = false;
    for (const status of statuses) {
      const label =
        status.state === 'checksum_mismatch' ? 'MISMATCH' : status.state;
      const appliedAt = status.appliedAt
        ? ` ${status.appliedAt.toISOString()}`
        : '';
      console.log(`${label}\t${status.id}${appliedAt}`);
      if (status.state === 'checksum_mismatch') mismatch = true;
    }
    if (mismatch) process.exitCode = 1;
  } finally {
    await world.close();
  }
}

/**
 * Assemble the committed steps into a script an operator can paste into psql.
 * Each step is its own `BEGIN … COMMIT` unit that runs the step DDL and then
 * writes the `__openqueue_migrations` bookkeeping row auto-apply would have
 * written — without it, `status` stays `pending` and boot refuses to start. The
 * schema + bookkeeping-table bootstrap is emitted once, inside the first unit;
 * its text is kept identical to the world's runner so a hand-applied print
 * produces the exact same database state. The CLI is world-agnostic and can't
 * import the world package, so this canonical text lives here and is
 * cross-checked against the runner in @openqueue/world-postgres's migration
 * suite. `id`/`checksum` are generator-produced constants; single quotes are
 * escaped defensively, matching the runner.
 */
function assembleMigrationScript(steps: readonly WorldMigrationStep[]): string {
  const bootstrapSql = `CREATE SCHEMA IF NOT EXISTS "openqueue";
CREATE TABLE IF NOT EXISTS "openqueue"."__openqueue_migrations" (
  "id" text primary key,
  "checksum" text not null,
  "applied_at" timestamptz not null default now()
);`;
  return steps
    .map((step, index) => {
      const id = step.id.replace(/'/g, "''");
      const checksum = step.checksum.replace(/'/g, "''");
      const bootstrap = index === 0 ? `${bootstrapSql}\n` : '';
      return `-- ${step.id}
BEGIN;
${bootstrap}${step.sql.trimEnd()}
INSERT INTO "openqueue"."__openqueue_migrations" (id, checksum) VALUES ('${id}', '${checksum}');
COMMIT;`;
    })
    .join('\n\n');
}

async function build(): Promise<void> {
  const { config, cwd } = await loadCliConfig();
  const outDir = config.build?.outDir ?? '.openqueue/build';
  const chunksDir = resolve(cwd, outDir, 'chunks');
  const manifest = resolve(cwd, outDir, 'manifest.mjs');
  const taskFiles = await discoverTaskFiles(config, cwd);

  if (taskFiles.length === 0) {
    throw new Error('OpenQueue build found no task files');
  }

  await mkdir(chunksDir, { recursive: true });
  const result = await Bun.build({
    entrypoints: taskFiles,
    outdir: chunksDir,
    target: 'bun',
    format: 'esm',
    splitting: true,
    sourcemap: 'external',
    // Keep the framework packages external so their task registry stays a single shared
    // singleton across all chunks (bundling a copy into each chunk → 0 registered tasks).
    external: Array.from(
      new Set(['@openqueue/*', ...(config.build?.external ?? [])]),
    ),
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log.message);
    throw new Error('OpenQueue build failed');
  }

  const outputs = result.outputs.filter((output) =>
    output.path.endsWith('.js'),
  );
  const entryOutputs = sortTaskFiles(
    outputs
      .filter((output) => output.kind === 'entry-point')
      .map((output) => output.path),
  );
  const outputFiles = outputs.map((output) => output.path).sort();
  const imports = entryOutputs
    .map((file) => {
      // Relative to the manifest so the built manifest stays portable — it can be moved to
      // a different absolute path (e.g. built on CI, copied into /app in a Docker image).
      const href = JSON.stringify(
        `./${relative(dirname(manifest), file).replaceAll('\\', '/')}`,
      );
      const label = JSON.stringify(relative(cwd, file).replaceAll('\\', '/'));
      return `setTaskDiscoveryContext(${label});
try {
  await import(${href});
} finally {
  clearTaskDiscoveryContext();
}`;
    })
    .join('\n');
  const content = `import {
  clearRegisteredTasks,
  clearTaskDiscoveryContext,
  getRegisteredTasks,
  setTaskDiscoveryContext,
  validateTaskDefinitions,
} from '@openqueue/core';

clearRegisteredTasks();
${imports}

export const tasks = validateTaskDefinitions(getRegisteredTasks());
export default tasks;
`;

  await mkdir(dirname(manifest), { recursive: true });
  await writeFile(manifest, content);
  const tasks = await importTasksFromManifest(manifest);
  const queues = new Set(tasks.map((task) => task.queue));
  const schedules = tasks.filter((task) => task.cron).length;
  const size = await bundleSize([manifest, ...outputFiles]);
  console.log(
    `OpenQueue build wrote ${tasks.length} tasks, ${queues.size} queues, ${schedules} schedules, ${formatBytes(size)} to ${manifest}`,
  );
}

async function loadDirectTasks(
  config: OpenQueueConfig,
  cwd: string,
): Promise<TaskDefinition[]> {
  if (config.tasks) {
    const loaded = await Promise.all(
      taskModules(config.tasks).map((source) => loadTaskModule(source, cwd)),
    );
    return validateTaskDefinitions(loaded.flat());
  }

  const files = await discoverTaskFiles(config, cwd);
  return loadTasksFromFiles(files, cwd);
}

async function dev(): Promise<void> {
  await loadEnvFile(envFilePath());
  const path = configPath();
  const cwd = dirname(path);
  const envPath = envFilePath();
  let child: Bun.Subprocess | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;

  const stopWorker = async () => {
    if (!child) return;
    const current = child;
    child = null;
    current.kill('SIGTERM');
    const kill = setTimeout(() => current.kill('SIGKILL'), 5000);
    await current.exited.catch(() => undefined);
    clearTimeout(kill);
  };

  const boot = async () => {
    await stopWorker();
    const script = fileURLToPath(import.meta.url);
    const cmd = [
      process.execPath,
      script,
      'dev-worker',
      '--config',
      path,
      ...(envPath ? ['--env-file', envPath] : []),
    ];
    const next = Bun.spawn(cmd, {
      cwd,
      env: process.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    child = next;
    next.exited.then((code) => {
      if (child !== next || closing) return;
      child = null;
      console.error(`[openqueue] worker exited with code ${code}`);
    });
  };

  const config = await loadConfig(path);
  await boot();
  const roots = (await watchRoots(config, path, cwd)).filter((item) =>
    existsSync(item),
  );
  const watchers = roots.map((root) =>
    watch(root, { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          console.log('[openqueue] change detected, restarting');
          await boot();
        } catch (err) {
          console.error(err instanceof Error ? err.message : err);
        }
      }, 100);
    }),
  );

  const close = async () => {
    closing = true;
    if (timer) clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
    await stopWorker();
    process.exit(0);
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
}

async function loadTaskModule(
  source: QueueConfigTaskModule,
  cwd: string,
): Promise<TaskDefinition[]> {
  const mod = (await import(
    pathToFileURL(resolve(cwd, source.module)).href
  )) as Record<string, unknown>;
  const value = exportedValue(mod, source);

  if (isTaskDiscovery(value)) {
    const files = await discoverDiscoveryFiles(value);
    return loadTasksFromFiles(files, discoveryRoot(value));
  }

  return validateTaskDefinitions(
    taskValues({ value }).filter(isTaskDefinition),
  );
}

async function importTasksFromManifest(
  manifest: string,
): Promise<TaskDefinition[]> {
  const mod = (await import(pathToFileURL(manifest).href)) as {
    tasks?: unknown[];
    default?: unknown[];
  };
  return (mod.tasks ?? mod.default ?? []).filter(isTaskDefinition);
}

async function loadTasksFromFiles(
  files: string[],
  cwd: string,
): Promise<TaskDefinition[]> {
  clearRegisteredTasks();
  for (const file of files) {
    setTaskDiscoveryContext(relative(cwd, file).replaceAll('\\', '/'));
    try {
      await import(pathToFileURL(file).href);
    } finally {
      clearTaskDiscoveryContext();
    }
  }
  return validateTaskDefinitions(getRegisteredTasks());
}

async function bundleSize(files: string[]): Promise<number> {
  const sizes = await Promise.all(
    files.map(async (file) => {
      const stats = await Bun.file(file).stat();
      return stats.size;
    }),
  );
  return sizes.reduce((total, size) => total + size, 0);
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

async function discoverTaskFiles(
  config: OpenQueueConfig,
  cwd: string,
): Promise<string[]> {
  const files: string[] = [];

  for (const dir of config.dirs ?? []) {
    files.push(
      ...(await scanFiles(resolve(cwd, dir), [
        '**/*.ts',
        '**/*.tsx',
        '**/*.mts',
        '**/*.cts',
        '**/*.js',
        '**/*.jsx',
        '**/*.mjs',
        '**/*.cjs',
      ])),
    );
  }

  for (const source of taskModules(config.tasks ?? [])) {
    const mod = (await import(
      pathToFileURL(resolve(cwd, source.module)).href
    )) as Record<string, unknown>;
    const value = exportedValue(mod, source);

    if (isTaskDiscovery(value)) {
      files.push(...(await discoverDiscoveryFiles(value)));
      continue;
    }

    files.push(resolve(cwd, source.module));
  }

  return sortTaskFiles(files.filter((file) => !excluded(file, config)));
}

async function discoverDiscoveryFiles(
  source: QueueTaskDiscovery,
): Promise<string[]> {
  return scanFiles(discoveryRoot(source), source.include, source.exclude);
}

async function scanFiles(
  cwd: string,
  include: string[],
  exclude: string[] = [],
): Promise<string[]> {
  const all = await Promise.all(
    include.map((pattern) =>
      Array.fromAsync(
        new Bun.Glob(pattern).scan({
          cwd,
          absolute: true,
        }),
      ),
    ),
  );
  const excludePatterns = [...defaultTaskDiscoveryExclude, ...exclude].map(
    globToRegExp,
  );
  return sortTaskFiles(
    Array.from(new Set(all.flat())).filter((file) => {
      const relative = file.slice(cwd.length + 1).replaceAll('\\', '/');
      return !excludePatterns.some((pattern) => pattern.test(relative));
    }),
  );
}

function excluded(file: string, config: OpenQueueConfig): boolean {
  const normalized = file.replaceAll('\\', '/');
  return (config.exclude ?? []).some((pattern) =>
    globToRegExp(pattern).test(normalized),
  );
}

function globToRegExp(glob: string): RegExp {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    const next = glob[i + 1];

    if (char === '*' && next === '*') {
      const after = glob[i + 2];
      if (after === '/') {
        out += '(?:.*/)?';
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
      continue;
    }

    if (char === '*') {
      out += '[^/]*';
      continue;
    }

    if (char === '?') {
      out += '.';
      continue;
    }

    out += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

async function loadCliConfig(): Promise<{
  config: OpenQueueConfig;
  cwd: string;
  path: string;
}> {
  await loadEnvFile(envFilePath());
  const path = configPath();
  const config = await loadConfig(path);
  return { config, cwd: dirname(path), path };
}

async function loadEnvFile(path: string | undefined): Promise<void> {
  if (!path) return;
  if (!existsSync(path)) {
    throw new Error(`OpenQueue env file "${path}" does not exist`);
  }

  const content = await readFile(path, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const index = trimmed.indexOf('=');
    if (index < 0) continue;

    const key = trimmed.slice(0, index).trim();
    if (!key || process.env[key] !== undefined) continue;

    process.env[key] = parseEnvValue(trimmed.slice(index + 1).trim());
  }
}

function parseEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function watchRoots(
  config: OpenQueueConfig,
  path: string,
  cwd: string,
): Promise<string[]> {
  const roots = [path, ...(config.dirs ?? []).map((dir) => resolve(cwd, dir))];

  for (const source of taskModules(config.tasks ?? [])) {
    const module = resolve(cwd, source.module);
    roots.push(module);

    const mod = (await import(pathToFileURL(module).href)) as Record<
      string,
      unknown
    >;
    const value = exportedValue(mod, source);
    if (isTaskDiscovery(value)) roots.push(discoveryRoot(value));
  }

  return Array.from(new Set(roots));
}

function discoveryRoot(source: QueueTaskDiscovery): string {
  if (source.cwd instanceof URL) return fileURLToPath(source.cwd);
  return resolve(source.cwd);
}

function taskModules(
  source: QueueConfigTaskModule | QueueConfigTaskModule[],
): QueueConfigTaskModule[] {
  return Array.isArray(source) ? source : [source];
}

function exportedValue(
  mod: Record<string, unknown>,
  source: QueueConfigTaskModule,
): unknown {
  if (source.export) {
    const value = mod[source.export];
    if (!value) {
      throw new Error(
        `OpenQueue task module "${source.module}" does not export "${source.export}"`,
      );
    }
    return value;
  }

  const value = mod.default ?? mod.tasks;
  if (!value) {
    throw new Error(
      `OpenQueue task module "${source.module}" must export default or tasks`,
    );
  }
  return value;
}

function taskValues(mod: Record<string, unknown>): unknown[] {
  return Object.values(mod).flatMap((value) =>
    Array.isArray(value) ? value : [value],
  );
}

function isTaskDiscovery(value: unknown): value is QueueTaskDiscovery {
  return (
    value !== null &&
    typeof value === 'object' &&
    'cwd' in value &&
    'include' in value &&
    Array.isArray((value as QueueTaskDiscovery).include)
  );
}

async function writeIfMissing(path: string, content: string): Promise<boolean> {
  try {
    await readFile(path);
    return false;
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return true;
  }
}

async function addDependencies(input: {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}): Promise<string[] | null> {
  const path = 'package.json';
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }

  const has = (name: string) =>
    ['dependencies', 'devDependencies'].some((key) => {
      const deps = pkg[key];
      return (
        !!deps &&
        typeof deps === 'object' &&
        name in (deps as Record<string, string>)
      );
    });

  const added: string[] = [];
  for (const key of ['dependencies', 'devDependencies'] as const) {
    const wanted = input[key];
    if (!wanted) continue;
    const current =
      pkg[key] && typeof pkg[key] === 'object'
        ? (pkg[key] as Record<string, string>)
        : {};
    for (const [name, version] of Object.entries(wanted)) {
      if (has(name)) continue;
      current[name] = version;
      added.push(name);
    }
    pkg[key] = current;
  }

  if (added.length > 0) {
    await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  return added;
}

async function updatePackageJson(): Promise<void> {
  const path = 'package.json';
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  const scripts =
    pkg.scripts && typeof pkg.scripts === 'object'
      ? (pkg.scripts as Record<string, string>)
      : {};
  pkg.scripts = {
    ...scripts,
    'worker:dev': scripts['worker:dev'] ?? 'openqueue dev --env-file .env',
    'worker:build': scripts['worker:build'] ?? 'openqueue build',
    'worker:start':
      scripts['worker:start'] ?? 'openqueue start --env-file .env',
  };

  const dependencies =
    pkg.dependencies && typeof pkg.dependencies === 'object'
      ? (pkg.dependencies as Record<string, string>)
      : {};
  pkg.dependencies = {
    ...dependencies,
    '@openqueue/sdk': dependencies['@openqueue/sdk'] ?? 'latest',
    '@openqueue/cli': dependencies['@openqueue/cli'] ?? 'latest',
    zod: dependencies.zod ?? 'latest',
  };

  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

function configPath(): string {
  const index = args.indexOf('--config');
  if (index >= 0 && args[index + 1]) {
    return resolve(process.cwd(), args[index + 1]!);
  }
  return resolve(process.cwd(), 'worker.config.ts');
}

function envFilePath(): string | undefined {
  const index = args.indexOf('--env-file');
  if (index >= 0 && args[index + 1]) {
    return resolve(process.cwd(), args[index + 1]!);
  }
  return undefined;
}

async function dockerfileTemplate(): Promise<string> {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../docker/worker/Dockerfile',
  );
  try {
    return await readFile(path, 'utf8');
  } catch {
    return `FROM oven/bun:1-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --production

COPY . .
RUN openqueue build

EXPOSE 8090
CMD ["openqueue", "start", "--env-file", ".env"]
`;
  }
}

function isTaskDefinition(value: unknown): value is TaskDefinition {
  return value !== null && typeof value === 'object' && 'handler' in value;
}

function help(): void {
  console.log(`openqueue

Commands:
  init      Create worker.config.ts and a starter worker task
  add       Add a feature to the project (persistence)
  dev       Start the worker from task source files
  build     Generate .openqueue/build/manifest.mjs
  start     Start the worker, preferring the generated manifest
  migrations  Print or check world migrations (print | status)
`);
}
