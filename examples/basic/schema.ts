import { defineQueueSchema } from '@openqueue/sdk';

// The demo owns a private Postgres schema, deliberately distinct from the e2e
// suite's `openqueue`/`openqueue_e2e` so an e2e reset never touches demo data.
export const queueSchema = defineQueueSchema({ schema: 'openqueue_demo' });

// drizzle-kit reads top-level table exports; re-export the schema's tables so
// `db:push` provisions them.
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
