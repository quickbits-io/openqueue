import { postgresAdapter } from '@openqueue/core/drizzle';
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
