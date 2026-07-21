#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Publish every public workspace package with `bun publish`. Bun rewrites the
// `workspace:` protocol to a real version at pack time, resolved from the
// workspace versions recorded in bun.lock — so the lockfile must match the
// bumped manifests (the release workflow runs a fresh `bun install` first).
// Publish order doesn't matter. Tags and GitHub releases are release-please's
// job, not this script's.

const rootDir = join(import.meta.dirname, '..');
const packagesDir = join(rootDir, 'packages');
const entries = await readdir(packagesDir, { withFileTypes: true });

// npm answers a publish-over-existing-version with a 403, so a re-run of the
// publish job must skip what already landed. A registry outage falls through
// to the publish attempt, where the real error surfaces.
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

const packages: {
  dir: string;
  manifest: { name: string; version: string };
}[] = [];

for (const entry of entries) {
  if (!entry.isDirectory()) continue;

  const dir = join(packagesDir, entry.name);
  const manifest: { name?: string; version?: string; private?: boolean } =
    JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));

  if (manifest.private || !manifest.name || !manifest.version) continue;

  packages.push({
    dir,
    manifest: { name: manifest.name, version: manifest.version },
  });
}

for (const { dir, manifest } of packages) {
  console.log(`\nValidating ${manifest.name}@${manifest.version}…`);
  const { status } = spawnSync('bun', ['publish', '--dry-run'], {
    cwd: dir,
    stdio: 'inherit',
  });
  if (status !== 0) {
    console.error(`Failed to validate ${manifest.name} (exit ${status})`);
    process.exit(status ?? 1);
  }
}

let published = 0;

for (const { dir, manifest } of packages) {
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

  published++;
}

console.log(
  published === 0
    ? 'Nothing to publish — registry already up to date.'
    : `\nPublished ${published} package(s).`,
);
