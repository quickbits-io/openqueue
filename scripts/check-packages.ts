#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Manifest {
  name?: string;
  version?: string;
  private?: boolean;
  exports?: Record<string, unknown>;
}

const root = join(import.meta.dirname, '..');
const packagesDir = join(root, 'packages');
const temp = await mkdtemp(join(tmpdir(), 'openqueue-packages-'));
const artifacts = join(temp, 'artifacts');
const consumer = join(temp, 'consumer');

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  await mkdir(artifacts);
  await mkdir(consumer);

  const packages: { manifest: Manifest; tarball: string }[] = [];
  const entries = await readdir(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const manifest = JSON.parse(
      await readFile(join(dir, 'package.json'), 'utf8'),
    ) as Manifest;
    if (manifest.private || !manifest.name || !manifest.version) continue;

    const destination = join(artifacts, entry.name);
    await mkdir(destination);
    run('bun', ['pm', 'pack', '--destination', destination, '--quiet'], dir);
    const tarballs = (await readdir(destination)).filter((file) =>
      file.endsWith('.tgz'),
    );
    if (tarballs.length !== 1) {
      throw new Error(`Expected one tarball for ${manifest.name}`);
    }
    packages.push({ manifest, tarball: join(destination, tarballs[0]!) });
  }

  const dependencies = Object.fromEntries(
    packages.map(({ manifest, tarball }) => [
      manifest.name,
      `file:${tarball}`,
    ]),
  );
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies,
      overrides: dependencies,
    }),
  );
  run('bun', ['install'], consumer);

  const imports = packages.flatMap(({ manifest }) =>
    Object.keys(manifest.exports ?? {})
      .filter((path) => !path.endsWith('.css'))
      .map((path) =>
        path === '.' ? manifest.name : `${manifest.name}${path.slice(1)}`,
      ),
  );
  await writeFile(
    join(consumer, 'check.mjs'),
    `${imports.map((specifier) => `await import(${JSON.stringify(specifier)});`).join('\n')}\n`,
  );
  run('bun', ['check.mjs'], consumer);

  const cli = packages.find(({ manifest }) => manifest.name === '@openqueue/cli');
  if (cli) {
    run(
      'bun',
      [join(consumer, 'node_modules/@openqueue/cli/dist/index.js'), '--help'],
      consumer,
    );
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
