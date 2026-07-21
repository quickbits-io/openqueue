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
  // dirs and tasks compose ("instead of — or alongside", per the config docs),
  // exactly like the build's discoverTaskFiles: enumerate every source file
  // (dirs globs + tasks modules), import them once serially in loadTasksFromFiles,
  // then read the full registry. This mirrors the worker's resolveTasks so the
  // dev/source worker and the built artifact resolve the same task set.
  const files = await discoverTaskFiles(config, cwd);
  return loadTasksFromFiles(files, cwd);
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
      ...(await scanFiles(
        resolve(cwd, dir),
        [
          '**/*.ts',
          '**/*.tsx',
          '**/*.mts',
          '**/*.cts',
          '**/*.js',
          '**/*.jsx',
          '**/*.mjs',
          '**/*.cjs',
        ],
        // Apply `config.exclude` relative to each scanned dir, like the worker's
        // defineQueueTasks path — a root-relative exclude (e.g. `generated/**`)
        // must match, which an absolute-path filter never did.
        config.exclude,
      )),
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

  return sortTaskFiles(files);
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
