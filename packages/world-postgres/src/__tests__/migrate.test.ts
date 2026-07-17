import type { WorldMigrationStep } from '@openqueue/core/world';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { migrationStatus, runMigrations } from '../migrate';
import { migrations } from '../migrations';
import { hasDb, testClient } from './test-db';

// Duplicates the CLI's `migrations print` assembly (packages/cli/src/index.ts)
// inline — the CLI is world-agnostic and can't be imported here — so this
// cross-checks that the exact script the CLI prints satisfies the runner: the
// schema + bookkeeping-table bootstrap, then per step the DDL and the
// bookkeeping insert auto-apply would have written, each in its own transaction.
const MIGRATIONS_BOOTSTRAP = `CREATE SCHEMA IF NOT EXISTS "openqueue";
CREATE TABLE IF NOT EXISTS "openqueue"."__openqueue_migrations" (
  "id" text primary key,
  "checksum" text not null,
  "applied_at" timestamptz not null default now()
);`;

function assembleMigrationScript(steps: readonly WorldMigrationStep[]): string {
  return steps
    .map((step, index) => {
      const id = step.id.replace(/'/g, "''");
      const checksum = step.checksum.replace(/'/g, "''");
      const bootstrap = index === 0 ? `${MIGRATIONS_BOOTSTRAP}\n` : '';
      return `-- ${step.id}
BEGIN;
${bootstrap}${step.sql.trimEnd()}
INSERT INTO "openqueue"."__openqueue_migrations" (id, checksum) VALUES ('${id}', '${checksum}');
COMMIT;`;
    })
    .join('\n\n');
}

describe.runIf(hasDb)('world-postgres migrations', () => {
  const sql = testClient();

  beforeEach(async () => {
    await sql.unsafe('drop schema if exists "openqueue" cascade');
  });
  afterAll(async () => {
    await sql.end();
  });

  async function bookkeepingCount(): Promise<number> {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from "openqueue"."__openqueue_migrations"
    `;
    return rows[0]?.n ?? 0;
  }

  it('applies a fresh schema and is a no-op on rerun', async () => {
    await runMigrations(sql, migrations, 'auto');
    expect(await bookkeepingCount()).toBe(migrations.length);
    const probe = await sql<{ reg: string | null }[]>`
      select to_regclass('openqueue.jobs') as reg
    `;
    expect(probe[0]?.reg).not.toBeNull();

    // Idempotent: rerun neither throws nor double-applies.
    await runMigrations(sql, migrations, 'auto');
    expect(await bookkeepingCount()).toBe(migrations.length);
  });

  it('serializes 5 concurrent runners via the advisory lock', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () => runMigrations(sql, migrations, 'auto')),
    );
    expect(await bookkeepingCount()).toBe(migrations.length);
  });

  it('hard-fails when a committed checksum changed after it was applied', async () => {
    await runMigrations(sql, migrations, 'auto');
    const tampered = migrations.map((step) => ({
      ...step,
      checksum: 'tampered-checksum',
    }));
    await expect(runMigrations(sql, tampered, 'auto')).rejects.toThrow(
      /different checksum/,
    );
    await expect(runMigrations(sql, tampered, 'manual')).rejects.toThrow(
      /different checksum/,
    );
  });

  it('fails manual mode on a pending migration, then auto applies it', async () => {
    await expect(runMigrations(sql, migrations, 'manual')).rejects.toThrow(
      /pending/,
    );
    await runMigrations(sql, migrations, 'auto');
    const status = await migrationStatus(sql, migrations);
    expect(status.every((step) => step.state === 'applied')).toBe(true);
  });

  it('unblocks manual boot after hand-applying the assembled `migrations print` output', async () => {
    // The hand-apply workflow: an operator reviews the printed script and runs
    // it themselves (in psql). We replay it over a reserved connection because
    // postgres.js refuses the script's explicit BEGIN/COMMIT on a pooled one.
    // Because the script carries the bookkeeping insert, `status` reads
    // `applied` and manual-mode boot proceeds — no `pending` refusal, no
    // `relation already exists` on a later auto boot.
    const reserved = await sql.reserve();
    try {
      await reserved.unsafe(assembleMigrationScript(migrations));
    } finally {
      reserved.release();
    }

    const status = await migrationStatus(sql, migrations);
    expect(status.every((step) => step.state === 'applied')).toBe(true);

    await expect(
      runMigrations(sql, migrations, 'manual'),
    ).resolves.toBeUndefined();
  });

  it('reports pending, applied, and checksum_mismatch states', async () => {
    const pending = await migrationStatus(sql, migrations);
    expect(pending.every((step) => step.state === 'pending')).toBe(true);

    await runMigrations(sql, migrations, 'auto');
    const applied = await migrationStatus(sql, migrations);
    expect(applied[0]?.state).toBe('applied');
    expect(applied[0]?.appliedAt).toBeInstanceOf(Date);

    const tampered = migrations.map((step) => ({
      ...step,
      checksum: 'tampered-checksum',
    }));
    const mismatch = await migrationStatus(sql, tampered);
    expect(mismatch[0]?.state).toBe('checksum_mismatch');
  });

  it('names the offending step in the checksum-mismatch failure', async () => {
    await runMigrations(sql, migrations, 'auto');
    const tampered = migrations.map((step) => ({
      ...step,
      checksum: 'tampered-checksum',
    }));
    // The message must identify which step diverged so an operator can reconcile it.
    await expect(runMigrations(sql, tampered, 'auto')).rejects.toThrow(
      new RegExp(migrations[0]?.id ?? '0001_init'),
    );
  });

  it('is a no-op in manual mode once every step is applied', async () => {
    await runMigrations(sql, migrations, 'auto');
    // Manual mode only refuses PENDING steps; with nothing pending it must not throw.
    await expect(
      runMigrations(sql, migrations, 'manual'),
    ).resolves.toBeUndefined();
    const status = await migrationStatus(sql, migrations);
    expect(status.every((step) => step.state === 'applied')).toBe(true);
  });
});
