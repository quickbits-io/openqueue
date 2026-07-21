import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearRegisteredTasks } from '@openqueue/core';
import { discoverTaskFiles, loadDirectTasks } from '../tasks';

// Fixtures live under the package so task modules resolve `@openqueue/core`.
const roots: string[] = [];

afterEach(async () => {
  clearRegisteredTasks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createRoot(): Promise<string> {
  const parent = join(process.cwd(), '.tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'cli-tasks-'));
  roots.push(root);
  return root;
}

function taskSource(id: string): string {
  return `import { task } from '@openqueue/core';
export const job = task({
  id: ${JSON.stringify(id)},
  queue: 'default',
  run: async () => ({ ok: true }),
});
`;
}

describe('discoverTaskFiles', () => {
  test('applies config.exclude relative to each scanned dir', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'worker', 'generated'), { recursive: true });
    await writeFile(join(root, 'worker', 'keep.ts'), 'export const x = 1;\n');
    await writeFile(
      join(root, 'worker', 'generated', 'skip.ts'),
      'export const y = 1;\n',
    );

    const files = await discoverTaskFiles(
      { namespace: 'x', dirs: ['worker'], exclude: ['generated/**'] },
      root,
    );

    expect(files.some((file) => file.endsWith('keep.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('skip.ts'))).toBe(false);
  });
});

describe('loadDirectTasks', () => {
  test('loads the union of dirs discovery and explicit task modules', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'worker'), { recursive: true });
    await writeFile(
      join(root, 'worker', 'alpha.ts'),
      taskSource('cli-union-alpha'),
    );
    // An explicit task module exports `default`/`tasks` (its `exportedValue`).
    await writeFile(
      join(root, 'beta.ts'),
      `import { task } from '@openqueue/core';
export default task({
  id: 'cli-union-beta',
  queue: 'default',
  run: async () => ({ ok: true }),
});
`,
    );

    const tasks = await loadDirectTasks(
      { namespace: 'x', dirs: ['worker'], tasks: [{ module: 'beta.ts' }] },
      root,
    );

    const ids = tasks.map((entry) => entry.id);
    expect(ids).toContain('cli-union-alpha');
    expect(ids).toContain('cli-union-beta');
  });
});
