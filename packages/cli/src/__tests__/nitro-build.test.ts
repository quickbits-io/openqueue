import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyExtraFiles } from '../nitro-build';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createRoot(): Promise<string> {
  const parent = join(process.cwd(), '.tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'cli-build-'));
  roots.push(root);
  return root;
}

describe('copyExtraFiles', () => {
  test('copies configured files into the artifact', async () => {
    const root = await createRoot();
    await mkdir(join(root, 'assets'), { recursive: true });
    await writeFile(join(root, 'assets', 'mail.html'), '<h1>hi</h1>');
    const outDir = join(root, '.output');

    await copyExtraFiles(['assets/mail.html'], root, outDir);

    expect(await Bun.file(join(outDir, 'assets', 'mail.html')).text()).toBe(
      '<h1>hi</h1>',
    );
  });

  test('throws on a missing entry', async () => {
    const root = await createRoot();
    await expect(
      copyExtraFiles(['missing.txt'], root, join(root, '.output')),
    ).rejects.toThrow('does not exist');
  });

  test('rejects a `../` entry that escapes the project root', async () => {
    const root = await createRoot();
    await expect(
      copyExtraFiles(['../escape.txt'], root, join(root, '.output')),
    ).rejects.toThrow('outside the project root');
  });

  test('rejects an absolute entry outside the project root', async () => {
    const root = await createRoot();
    await expect(
      copyExtraFiles(['/etc/hosts'], root, join(root, '.output')),
    ).rejects.toThrow('outside the project root');
  });
});
