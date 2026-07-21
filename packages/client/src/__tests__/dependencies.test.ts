import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('published dependency graph', () => {
  it('depends only on zod and declares no peerDependencies', () => {
    const path = fileURLToPath(new URL('../../package.json', import.meta.url));
    const pkg: {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    } = JSON.parse(readFileSync(path, 'utf8'));

    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod']);
    expect(pkg.peerDependencies).toBeUndefined();
  });
});
