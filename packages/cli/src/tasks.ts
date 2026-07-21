import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  clearTaskDiscoveryContext,
  defaultTaskDiscoveryExclude,
  getRegisteredTasks,
  type OpenQueueConfig,
  type QueueConfigTaskModule,
  type QueueTaskDiscovery,
  setTaskDiscoveryContext,
  sortTaskFiles,
  type TaskDefinition,
  validateTaskDefinitions,
} from '@openqueue/core';

/**
 * Resolve the config's tasks by importing each source file in the CLI process
 * — used by `dev-worker` and the source-boot fallback of `start`. `dirs`
 * discovery walks the filesystem; `tasks` modules import the configured entry.
 */
export async function loadDirectTasks(
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

/**
 * Import each discovered file under a discovery context so the tasks it
 * registers carry a stable source label, then snapshot the full registry.
 *
 * Deliberately does NOT clear the registry first: a config that statically
 * imports its own task files registers them before discovery runs, so a
 * clear+reimport would re-import the now-cached modules with no side effect and
 * yield zero tasks. Importing (registering anything new) then reading the whole
 * registry unions the config's imports with discovery; `validateTaskDefinitions`
 * still fails genuine duplicate ids.
 */
export async function loadTasksFromFiles(
  files: string[],
  cwd: string,
): Promise<TaskDefinition[]> {
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

/**
 * Enumerate the task source files a config points at (via `dirs` globs and/or
 * `tasks` modules), sorted deterministically and with excludes applied.
 */
export async function discoverTaskFiles(
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

export function taskModules(
  source: QueueConfigTaskModule | QueueConfigTaskModule[],
): QueueConfigTaskModule[] {
  return Array.isArray(source) ? source : [source];
}

export function exportedValue(
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

export function isTaskDiscovery(value: unknown): value is QueueTaskDiscovery {
  return (
    value !== null &&
    typeof value === 'object' &&
    'cwd' in value &&
    'include' in value &&
    Array.isArray((value as QueueTaskDiscovery).include)
  );
}

export function discoveryRoot(source: QueueTaskDiscovery): string {
  if (source.cwd instanceof URL) return fileURLToPath(source.cwd);
  return resolve(source.cwd);
}

function isTaskDefinition(value: unknown): value is TaskDefinition {
  return value !== null && typeof value === 'object' && 'handler' in value;
}
