import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { clearRegisteredTasks, worldLocal } from '@openqueue/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkerApp } from './app';

/**
 * `dirs` and `tasks` compose ("alongside", per the config docs), matching the
 * build's discovery. A config that sets both must load the union — not just the
 * explicit modules — so the source/dev worker and the built artifact run the
 * same task set.
 */
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
  const root = await mkdtemp(join(parent, 'resolve-tasks-'));
  roots.push(root);
  return root;
}

function taskSource(id: string, queue: string): string {
  return `import { task } from '@openqueue/core';
export const job = task({
  id: ${JSON.stringify(id)},
  queue: ${JSON.stringify(queue)},
  run: async () => ({ ok: true }),
});
`;
}

describe('createWorkerApp — dirs and tasks compose', () => {
  it('loads the union of dirs discovery and explicit task modules', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'dir-tasks'), { recursive: true });
    await writeFile(
      join(root, 'dir-tasks', 'alpha.ts'),
      taskSource('rt-alpha', 'default'),
    );
    await writeFile(
      join(root, 'module-tasks.ts'),
      `import { task } from '@openqueue/core';
export const tasks = [
  task({ id: 'rt-beta', queue: 'default', run: async () => ({ ok: true }) }),
];
`,
    );

    const handle = await createWorkerApp(
      {
        namespace: 'resolve-tasks',
        world: worldLocal(),
        dirs: ['dir-tasks'],
        tasks: [{ module: 'module-tasks.ts' }],
      },
      { cwd: root },
    );

    const ids = handle.runtime.tasks.map((entry) => entry.id);
    expect(ids).toContain('rt-alpha');
    expect(ids).toContain('rt-beta');

    await handle.close();
  });

  it('accepts a task module whose default export is a single task definition', async () => {
    const root = await createRoot();
    await writeFile(
      join(root, 'single-task.ts'),
      `import { task } from '@openqueue/core';
export default task({
  id: 'rt-single',
  queue: 'default',
  run: async () => ({ ok: true }),
});
`,
    );

    const handle = await createWorkerApp(
      {
        namespace: 'resolve-tasks-single',
        world: worldLocal(),
        tasks: [{ module: 'single-task.ts' }],
      },
      { cwd: root },
    );

    expect(handle.runtime.tasks.map((entry) => entry.id)).toContain(
      'rt-single',
    );

    await handle.close();
  });
});
