import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearRegisteredTasks,
  defineQueueTasks,
  loadQueueTasks,
} from '../index';

const core = '@openqueue/core';
const roots: string[] = [];

afterEach(async () => {
  clearRegisteredTasks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('task discovery', () => {
  it('does not duplicate tasks re-exported through an index file', async () => {
    const root = await createRoot();
    await taskFile(root, 'job.ts', 'barrel-job');
    await writeFile(join(root, 'index.ts'), "export { job } from './job';\n");

    const tasks = await discover(root);

    expect(tasks.map((task) => task.id)).toEqual(['barrel-job']);
  });

  it('reports real duplicate task ids with source files', async () => {
    const root = await createRoot();
    await taskFile(root, 'a.ts', 'duplicate-job', 'alpha');
    await taskFile(root, 'b.ts', 'duplicate-job', 'beta');

    await expect(discover(root)).rejects.toThrow(
      'duplicate task id "duplicate-job" for queues "alpha" and "beta" in "a.ts" and "b.ts"',
    );
  });

  it('does not keep stale registrations across fresh discovery runs', async () => {
    const first = await createRoot();
    const second = await createRoot();
    await taskFile(first, 'job.ts', 'restart-job');
    await taskFile(second, 'job.ts', 'restart-job');

    await expect(discover(first)).resolves.toHaveLength(1);
    clearRegisteredTasks();
    await expect(discover(second)).resolves.toHaveLength(1);
  });
});

async function createRoot(): Promise<string> {
  const parent = join(process.cwd(), '.tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'discovery-'));
  roots.push(root);
  return root;
}

async function discover(root: string) {
  return loadQueueTasks(
    defineQueueTasks({
      cwd: root,
      include: ['**/*.ts'],
    }),
  );
}

async function taskFile(
  root: string,
  file: string,
  id: string,
  queue = 'test',
): Promise<void> {
  await writeFile(
    join(root, file),
    `import { task } from ${JSON.stringify(core)};

export const job = task({
  id: ${JSON.stringify(id)},
  queue: ${JSON.stringify(queue)},
  run: async () => ({ ok: true }),
});
`,
  );
}
