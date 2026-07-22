import type {
  WorldMigrationStatus,
  WorldMigrationStep,
} from '@openqueue/core/world';
import type postgres from 'postgres';

/**
 * Session-level advisory lock that serializes migration runners across every
 * worker sharing a database. The literal spells "oq" + a version nibble; it is
 * frozen — changing it would let two fleets migrate concurrently. Part of the
 * OpenQueue advisory-key registry kept at `RETENTION_PRUNE_LOCK_KEY` in
 * `@openqueue/core/drizzle`.
 */
export const MIGRATION_LOCK_KEY = 0x6f710001;

export type MigrationMode = 'auto' | 'manual';

interface AppliedRow {
  id: string;
  checksum: string;
  // A drizzle store query on the shared client disables postgres.js's timestamp
  // parser, so this can arrive as a string — coerce with toDate.
  applied_at: Date | string;
}

/**
 * Apply pending migrations under an advisory lock. Idempotent and crash-safe:
 * each step's DDL and its bookkeeping row commit in one implicit transaction, so
 * a killed runner leaves no half-applied step. An already-applied step whose
 * committed checksum no longer matches is a hard failure in BOTH modes — the
 * migration changed after it ran. In `manual` mode a pending step fails with an
 * actionable message instead of running DDL.
 */
export async function runMigrations(
  sql: postgres.Sql,
  steps: readonly WorldMigrationStep[],
  mode: MigrationMode,
): Promise<void> {
  // Manual mode never mutates the database: it probes migration state read-only
  // and fails on a pending (or diverged) step. Bootstrap DDL (the schema +
  // bookkeeping table) and step application run only under `auto`, so a
  // restricted role without CREATE gets the actionable pending guidance rather
  // than a permission error, and a privileged manual boot leaves the DB untouched.
  if (mode === 'manual') {
    await assertMigrationsApplied(sql, steps);
    return;
  }

  const reserved = await sql.reserve();
  try {
    await reserved`select pg_advisory_lock(${MIGRATION_LOCK_KEY}::bigint)`;
    try {
      await reserved.unsafe('create schema if not exists "openqueue"');
      await reserved.unsafe(
        `create table if not exists "openqueue"."__openqueue_migrations" (
          "id" text primary key,
          "checksum" text not null,
          "applied_at" timestamptz not null default now()
        )`,
      );
      const applied = await reserved<AppliedRow[]>`
        select id, checksum, applied_at from "openqueue"."__openqueue_migrations"
      `;
      const appliedById = new Map(applied.map((row) => [row.id, row.checksum]));

      for (const step of steps) {
        const existing = appliedById.get(step.id);
        if (existing !== undefined) {
          assertChecksum(step, existing);
          continue;
        }
        await applyStep(reserved, step);
      }
    } finally {
      await reserved`select pg_advisory_unlock(${MIGRATION_LOCK_KEY}::bigint)`;
    }
  } finally {
    reserved.release();
  }
}

/**
 * Read-only assertion that every step is applied with a matching checksum —
 * never takes the lock or runs DDL. `to_regclass` returns null (no error) when
 * the bookkeeping table is absent, so an uninitialized database reports every
 * step as pending. A diverged checksum is a hard failure, exactly as in `auto`.
 */
async function assertMigrationsApplied(
  sql: postgres.Sql,
  steps: readonly WorldMigrationStep[],
): Promise<void> {
  const [probe] = await sql<{ reg: string | null }[]>`
    select to_regclass(${'openqueue.__openqueue_migrations'}) as reg
  `;
  const applied = probe?.reg
    ? await sql<{ id: string; checksum: string }[]>`
        select id, checksum from "openqueue"."__openqueue_migrations"
      `
    : [];
  const appliedById = new Map(applied.map((row) => [row.id, row.checksum]));

  for (const step of steps) {
    const existing = appliedById.get(step.id);
    if (existing === undefined) {
      throw new Error(
        `@openqueue/world-postgres: migration "${step.id}" is pending. Review and apply the full output of \`openqueue migrations print\` — it includes the bookkeeping insert that marks the migration applied, so boot proceeds afterwards — or set migrations: 'auto' to apply it on boot.`,
      );
    }
    assertChecksum(step, existing);
  }
}

/**
 * Read-only migration status: never takes the lock, never runs DDL. Reports
 * `pending` when the bookkeeping table (or the row) is absent, `checksum_mismatch`
 * when a committed step diverges from what was applied.
 */
export async function migrationStatus(
  sql: postgres.Sql,
  steps: readonly WorldMigrationStep[],
): Promise<WorldMigrationStatus[]> {
  const [probe] = await sql<{ reg: string | null }[]>`
    select to_regclass(${'openqueue.__openqueue_migrations'}) as reg
  `;
  const applied = probe?.reg
    ? await sql<AppliedRow[]>`
          select id, checksum, applied_at from "openqueue"."__openqueue_migrations"
        `
    : [];
  const byId = new Map(applied.map((row) => [row.id, row]));

  return steps.map((step) => {
    const row = byId.get(step.id);
    if (!row) return { id: step.id, state: 'pending' };
    const appliedAt = toDate(row.applied_at);
    if (row.checksum !== step.checksum) {
      return { id: step.id, state: 'checksum_mismatch', appliedAt };
    }
    return { id: step.id, state: 'applied', appliedAt };
  });
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function assertChecksum(step: WorldMigrationStep, applied: string): void {
  if (applied === step.checksum) return;
  throw new Error(
    `@openqueue/world-postgres: migration "${step.id}" was already applied with a different checksum (database=${applied}, committed=${step.checksum}). A committed migration changed after it ran — reconcile it by hand rather than auto-applying.`,
  );
}

/**
 * DDL + bookkeeping insert in one multi-statement simple query, which Postgres
 * runs as a single implicit transaction (all-or-nothing). `id`/`checksum` are
 * generator-produced constants; single quotes are escaped defensively.
 */
async function applyStep(
  sql: postgres.ReservedSql,
  step: WorldMigrationStep,
): Promise<void> {
  const id = step.id.replace(/'/g, "''");
  const checksum = step.checksum.replace(/'/g, "''");
  await sql.unsafe(
    `${step.sql}\ninsert into "openqueue"."__openqueue_migrations" (id, checksum) values ('${id}', '${checksum}');`,
  );
}
