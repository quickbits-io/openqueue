#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Publish every public workspace package with `bun publish`. Bun rewrites the
// `workspace:` protocol to a real version at pack time, resolved from the
// workspace versions recorded in bun.lock — so the lockfile must match the
// bumped manifests (the `version-packages` script refreshes it after bumping).
// Publish order doesn't matter. After publishing, `changeset tag` creates the
// git tags the release workflow pushes.

const rootDir = join(import.meta.dirname, '..');
const packagesDir = join(rootDir, 'packages');
const entries = await readdir(packagesDir, { withFileTypes: true });

const published: string[] = [];

// npm answers a publish-over-existing-version with a 403, which the workflow
// surfaced as a failed release on every no-changeset merge. Skip versions the
// registry already has so the publish step is idempotent; a registry outage
// falls through to the publish attempt, where the real error surfaces.
async function alreadyPublished(name: string, version: string) {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${name.replace('/', '%2f')}/${version}`,
    );
    return response.ok;
  } catch {
    return false;
  }
}

for (const entry of entries) {
  if (!entry.isDirectory()) continue;

  const dir = join(packagesDir, entry.name);
  const manifest: { name?: string; version?: string; private?: boolean } =
    JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));

  if (manifest.private || !manifest.name || !manifest.version) continue;

  if (await alreadyPublished(manifest.name, manifest.version)) {
    console.log(
      `Skipping ${manifest.name}@${manifest.version} — already on the registry.`,
    );
    continue;
  }

  console.log(`\nPublishing ${manifest.name}@${manifest.version}…`);
  const { status } = spawnSync('bun', ['publish', '--no-git-checks'], {
    cwd: dir,
    stdio: 'inherit',
  });

  if (status !== 0) {
    console.error(`Failed to publish ${manifest.name} (exit ${status})`);
    process.exit(status ?? 1);
  }

  published.push(manifest.name);
}

if (published.length === 0) {
  console.log('No public packages to publish.');
  process.exit(0);
}

console.log(`\nTagging ${published.length} published package(s)…`);
const { status } = spawnSync('bun', ['x', 'changeset', 'tag'], {
  cwd: rootDir,
  stdio: 'inherit',
});

process.exit(status ?? 1);
