import { defineQueueSchema } from '@openqueue/sdk';
import { PG_SCHEMA } from './env';

export const queueSchema = defineQueueSchema({ schema: PG_SCHEMA });

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
