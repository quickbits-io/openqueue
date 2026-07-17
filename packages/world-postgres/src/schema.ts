import { defineQueueSchema } from '@openqueue/core/drizzle';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * The `openqueue` world owns a fixed schema: the eight `defineQueueSchema`
 * tables (durable catalog / schedules / runs / alerts, read+written through
 * `postgresAdapter`) plus one `jobs` delivery table this transport polls with
 * `SELECT ... FOR UPDATE SKIP LOCKED`. Everything lives under the `openqueue`
 * Postgres schema so it can share a database with a bring-your-own
 * `postgresAdapter` store on a disjoint schema.
 *
 * This module is the drizzle-kit generate input; the transport itself speaks
 * raw SQL (advisory locks, SKIP LOCKED, row-value predicates) rather than the
 * query builder, so `jobs` is defined here purely to emit the committed
 * migration DDL.
 */
export const queueSchema = defineQueueSchema({ schema: 'openqueue' });

export const {
  queueCatalog,
  queueSchedules,
  queueScheduleInstances,
  queueRuns,
  queueRunEvents,
  queueRunSpans,
  alertChannels,
  alertRules,
} = queueSchema;

const openqueue = pgSchema('openqueue');

/**
 * Ephemeral delivery state — one row per not-yet-terminal job, deleted on
 * completion or final failure. Run history lives in `runs`, not here. The
 * `namespace` column keeps N workers on one database from stealing each other's
 * jobs; the claim index covers the poll predicate + ordering.
 */
export const jobs = openqueue.table(
  'jobs',
  {
    namespace: text().notNull(),
    queue: text().notNull(),
    id: text().notNull(),
    name: text().notNull(),
    data: jsonb(),
    priority: integer().default(0).notNull(),
    attempts: integer().default(1).notNull(),
    attemptsMade: integer('attempts_made').default(0).notNull(),
    backoff: jsonb(),
    state: text().default('waiting').notNull(),
    runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    stalledCount: integer('stalled_count').default(0).notNull(),
    seq: bigint({ mode: 'bigint' }).generatedAlwaysAsIdentity(),
    processedOn: timestamp('processed_on', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      name: 'jobs_pk',
      columns: [table.namespace, table.queue, table.id],
    }),
    index('openqueue_jobs_claim_idx').on(
      table.namespace,
      table.queue,
      table.state,
      table.runAt,
      table.priority,
      table.seq,
    ),
  ],
);
