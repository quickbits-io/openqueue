import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  clearTaskDiscoveryContext,
  getRegisteredTasks,
  setTaskDiscoveryContext,
  validateTaskDefinitions,
} from './task';
import type { TaskDefinition } from './types';

export interface QueueTaskDiscovery {
  cwd: URL | string;
  include: string[];
  exclude?: string[];
}

export const defaultTaskDiscoveryExclude = [
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.test.mjs',
  '**/*.test.cjs',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  '**/*.spec.mjs',
  '**/*.spec.cjs',
  '**/*.fixture.ts',
  '**/*.fixture.tsx',
  '**/*.fixture.js',
  '**/*.fixture.jsx',
  '**/*.fixture.mjs',
  '**/*.fixture.cjs',
  '**/*.d.ts',
  '**/__tests__/**',
  '**/__fixtures__/**',
  '**/node_modules/**',
  '**/.git/**',
  '**/.openqueue/**',
  '**/dist/**',
  '**/build/**',
];

export function defineQueueTasks(
  discovery: QueueTaskDiscovery,
): QueueTaskDiscovery {
  return discovery;
}

export async function loadQueueTasks(
  source: QueueTaskDiscovery | TaskDefinition[],
): Promise<TaskDefinition[]> {
  if (Array.isArray(source)) return validateTaskDefinitions(source);

  const cwd = source.cwd instanceof URL ? source.cwd.pathname : source.cwd;
  const root = resolve(decodeURIComponent(cwd));
  const include = source.include.map(globToRegExp);
  const exclude = [
    ...defaultTaskDiscoveryExclude,
    ...(source.exclude ?? []),
  ].map(globToRegExp);
  const files = await listFiles(root);
  const start = getRegisteredTasks().length;

  for (const file of files) {
    const relative = file.slice(root.length + 1).replaceAll('\\', '/');
    if (!include.some((pattern) => pattern.test(relative))) continue;
    if (exclude.some((pattern) => pattern.test(relative))) continue;
    setTaskDiscoveryContext(relative);
    try {
      await import(pathToFileURL(file).href);
    } finally {
      clearTaskDiscoveryContext();
    }
  }

  return validateTaskDefinitions(getRegisteredTasks().slice(start));
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) return listFiles(path);
      return entry.isFile() ? [path] : [];
    }),
  );
  return sortTaskFiles(files.flat());
}

export function sortTaskFiles(files: string[]): string[] {
  return [...files].sort((a, b) => {
    const indexDiff = indexFileScore(a) - indexFileScore(b);
    if (indexDiff !== 0) return indexDiff;
    return a.localeCompare(b);
  });
}

function indexFileScore(file: string): number {
  return /(^|[/\\])index\.[cm]?[jt]sx?$/.test(file) ? 1 : 0;
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

    out += escapeRegExp(char);
  }
  return new RegExp(`${out}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
