import {
  postgresAdapter,
  RETENTION_PRUNE_LOCK_KEY,
} from '@openqueue/core/drizzle';
import type {
  QueueRunSnapshot,
  QueueStorage,
  RunStatus,
} from '@openqueue/core/types';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  queueRunEvents,
  queueRunSpans,
  queueRuns,
  queueSchema,
} from '../schema';
import { hasDb, resetSchema, testClient } from './test-db';

/**
 * The drizzle store's retention prune against real Postgres: terminal runs go
 * by their bucket's cutoff (counted from `finished_at`), events/spans go when
 * older than `logsBefore` OR orphaned by a pruned run — with the orphans
 * deleted (and counted) ahead of the FK cascade.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

function snapshot(
  id: string,
  status: RunStatus,
  finishedDaysAgo?: number,
): QueueRunSnapshot {
  return {
    id,
    name: 'echo',
    queue: 'default',
    status,
    input: {},
    meta: {},
    metadata: {},
    tags: [],
    attempt: 1,
    maxAttempts: 1,
    willRetry: false,
    createdAt: daysAgo(200),
    finishedAt:
      finishedDaysAgo === undefined ? undefined : daysAgo(finishedDaysAgo),
  };
}

function span(id: string, runId: string) {
  return {
    id,
    runId,
    attempt: 1,
    traceId: 'trace',
    spanId: id,
    kind: 'span' as const,
    name: 'work',
    startedAt: daysAgo(1),
  };
}

describe.runIf(hasDb)('postgresAdapter retention prune', () => {
  const sql = testClient();
  const db = drizzle(sql);
  let store: QueueStorage;

  beforeAll(async () => {
    await resetSchema(sql);
    store = postgresAdapter({ db, schema: queueSchema });

    // Each handle() upserts the run and appends one (young) run event.
    const seeds: Array<[string, RunStatus, number | undefined]> = [
      ['old-completed', 'completed', 40],
      ['new-completed', 'completed', 10],
      ['old-failed', 'failed', 100],
      ['mid-failed', 'failed', 40],
      ['ancient-executing', 'executing', undefined],
    ];
    for (const [id, status, finishedDaysAgo] of seeds) {
      await store.handle({
        type: status === 'executing' ? 'start' : 'complete',
        run: snapshot(id, status, finishedDaysAgo),
      });
    }

    // Aged telemetry on a run that itself survives.
    await db.insert(queueRunEvents).values([
      {
        id: 'event-old-1',
        runId: 'new-completed',
        type: 'progress',
        createdAt: daysAgo(40).toISOString(),
      },
      {
        id: 'event-old-2',
        runId: 'new-completed',
        type: 'progress',
        createdAt: daysAgo(40).toISOString(),
      },
    ]);
    await db.insert(queueRunSpans).values({
      ...span('span-old', 'new-completed'),
      startedAt: daysAgo(40).toISOString(),
      createdAt: daysAgo(40).toISOString(),
    });
    // Young spans: one on a surviving run, two on a doomed run (orphans).
    await store.spans?.insertMany([
      span('span-young', 'new-completed'),
      span('span-orphan-1', 'old-completed'),
      span('span-orphan-2', 'old-completed'),
    ]);
  });

  afterAll(async () => {
    await sql.end();
  });

  it('prunes nothing when every cutoff is unset', async () => {
    await expect(store.runs.prune?.({})).resolves.toEqual({
      runs: 0,
      events: 0,
      spans: 0,
    });
  });

  it('deletes aged runs, aged telemetry, and telemetry orphaned by run deletion', async () => {
    const result = await store.runs.prune?.({
      completedBefore: daysAgo(30),
      failedBefore: daysAgo(90),
      logsBefore: daysAgo(30),
    });

    // Runs: old-completed (40d > 30d) + old-failed (100d > 90d).
    // Events: their two lifecycle events + the two aged ones on new-completed.
    // Spans: the aged one on new-completed + the two orphans on old-completed.
    expect(result).toEqual({ runs: 2, events: 4, spans: 3 });

    const remaining = await store.runs.list({ limit: 500 });
    expect(remaining.data.map((run) => run.id).sort()).toEqual([
      'ancient-executing',
      'mid-failed',
      'new-completed',
    ]);

    const events = await db
      .select({ id: queueRunEvents.id, runId: queueRunEvents.runId })
      .from(queueRunEvents);
    expect(events.map((event) => event.runId).sort()).toEqual([
      'ancient-executing',
      'mid-failed',
      'new-completed',
    ]);

    const spans = await db.select({ id: queueRunSpans.id }).from(queueRunSpans);
    expect(spans.map((row) => row.id)).toEqual(['span-young']);

    const runs = await db.select({ id: queueRuns.id }).from(queueRuns);
    expect(runs).toHaveLength(3);
  });
});

describe.runIf(hasDb)('postgresAdapter retention prune — coordination', () => {
  const sql = testClient();
  const store = postgresAdapter({ db: drizzle(sql), schema: queueSchema });

  beforeAll(async () => {
    await resetSchema(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  it('reports skipped while another session holds the prune lock, then works', async () => {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${RETENTION_PRUNE_LOCK_KEY}::bigint)`;
      await expect(
        store.runs.prune?.({ logsBefore: daysAgo(30) }),
      ).resolves.toEqual({ skipped: true });
    });

    // The competitor's transaction released the lock — the next sweep works.
    await expect(
      store.runs.prune?.({ logsBefore: daysAgo(30) }),
    ).resolves.toEqual({ runs: 0, events: 0, spans: 0 });
  });
});

describe.runIf(hasDb)('postgresAdapter retention prune — batching cap', () => {
  const sql = testClient();
  const store = postgresAdapter({ db: drizzle(sql), schema: queueSchema });
  // 40 batches × 5000 rows per category per sweep.
  const SWEEP_CAP = 200_000;
  const EXTRA = 50;

  beforeAll(async () => {
    await resetSchema(sql);
    // Parent run for the FK; young enough to survive the sweep. Its own
    // lifecycle event is young too, so only the seeded backlog is prunable.
    await store.handle({
      type: 'complete',
      run: snapshot('bulk-run', 'completed', 1),
    });
    await sql.unsafe(`
      insert into "openqueue"."run_events" (id, run_id, type, data, created_at)
      select 'bulk-' || g, 'bulk-run', 'progress', '{}'::jsonb,
             now() - interval '40 days'
      from generate_series(1, ${SWEEP_CAP + EXTRA}) g
    `);
  }, 60_000);

  afterAll(async () => {
    await sql.end();
  });

  it('caps one sweep at the batch budget and drains the rest on the next', {
    timeout: 120_000,
  }, async () => {
    const first = await store.runs.prune?.({ logsBefore: daysAgo(30) });
    expect(first).toEqual({ runs: 0, events: SWEEP_CAP, spans: 0 });

    const second = await store.runs.prune?.({ logsBefore: daysAgo(30) });
    expect(second).toEqual({ runs: 0, events: EXTRA, spans: 0 });

    const [row] = await sql<
      { count: number }[]
    >`select count(*)::int as count from "openqueue"."run_events"`;
    // Only bulk-run's young lifecycle event survives.
    expect(row?.count).toBe(1);
  });
});
