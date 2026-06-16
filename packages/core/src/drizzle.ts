import { and, asc, desc, eq, gte, lte, type SQL, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type {
  AlertContactPoint,
  AlertContactPointPreset,
  AlertRule,
  AlertSeverity,
  AlertStore,
  AlertTrigger,
  BackoffOptions,
  EnqueueMeta,
  QueueCatalogEntry,
  QueueRun,
  QueueRunListOptions,
  QueueRunListResult,
  QueueRunSnapshot,
  QueueRunSpan,
  QueueSchedule,
  QueueScheduleListOptions,
  QueueScheduleUpdateInput,
  QueueStorage,
  RunStatus,
  SerializedError,
} from './types';

interface DbQuery<T> extends PromiseLike<T> {
  from(table: unknown): DbQuery<T>;
  limit(value: number): DbQuery<T>;
  onConflictDoUpdate(value: unknown): DbQuery<T>;
  offset(value: number): DbQuery<T>;
  orderBy(value: unknown): DbQuery<T>;
  returning(value: unknown): DbQuery<T>;
  set(value: unknown): DbQuery<T>;
  values(value: unknown): DbQuery<T>;
  where(value: unknown): DbQuery<T>;
}

interface Transaction {
  delete(table: unknown): DbQuery<unknown[]>;
  insert(table: unknown): DbQuery<unknown[]>;
  select(value?: unknown): DbQuery<unknown[]>;
  update(table: unknown): DbQuery<unknown[]>;
}

interface CatalogRow {
  id: string;
  name: string;
  queue: string;
  attempts: number;
  backoff: BackoffOptions;
  concurrency: number;
  ttl: number | null;
  max_stalled_count: number | null;
  cron: string | null;
  tags: string[];
  description: string | null;
  schema: { type: string } | null;
  updated_at: Date | string;
  version: string;
}

interface ScheduleRow {
  id: string;
  task: string;
  type: string;
  input: unknown;
  active: boolean;
  cron: string;
  timezone: string;
  external_id: string | null;
  deduplication_key: string | null;
  meta: EnqueueMeta | null;
  next_run_at: Date | string | null;
  last_run_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface RunRow {
  id: string;
  transport_job_id: string | null;
  task: string;
  queue: string;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: SerializedError | null;
  meta: EnqueueMeta | null;
  metadata: Record<string, unknown> | null;
  tags: string[];
  schedule_id: string | null;
  schedule_external_id: string | null;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  updated_at: Date | string;
}

interface SpanRow {
  id: string;
  run_id: string;
  attempt: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  kind: 'span' | 'log';
  name: string;
  level: string | null;
  status: string | null;
  error: QueueRunSpan['error'] | null;
  started_at: Date | string;
  duration_ms: number | null;
  attributes: Record<string, unknown> | null;
}

interface AlertChannelRow {
  id: string;
  name: string;
  preset: AlertContactPointPreset;
  url: string;
  enabled: boolean;
  display_name: string | null;
  icon_url: string | null;
  headers: Record<string, string> | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface AlertRuleRow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: AlertTrigger;
  severity: AlertSeverity;
  queues: string[];
  job_names: string[];
  threshold: number | null;
  contact_point_ids: string[];
  cooldown_ms: number | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface DefineQueueSchemaOptions {
  schema?: string;
}

export type QueueDrizzleSchema = ReturnType<typeof defineQueueSchema>;

export interface PostgresAdapterOptions {
  db: unknown;
  schema?: string | QueueDrizzleSchema;
}

export function defineQueueSchema(options: DefineQueueSchemaOptions = {}) {
  const schema = pgSchema(options.schema ?? 'public');

  const queueCatalog = schema.table(
    'catalog',
    {
      id: text().primaryKey().notNull(),
      name: text().notNull(),
      queue: text().notNull(),
      attempts: integer().notNull(),
      backoff: jsonb().$type<BackoffOptions>().notNull(),
      concurrency: integer().notNull(),
      ttl: integer(),
      maxStalledCount: integer('max_stalled_count'),
      cron: text(),
      tags: text().array().default([]).notNull(),
      description: text(),
      schemaMetadata: jsonb('schema').$type<{ type: string }>(),
      updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'string',
      }).notNull(),
      version: text().notNull(),
    },
    (table) => [
      index('queue_catalog_queue_idx').on(table.queue),
      index('queue_catalog_updated_at_idx').on(table.updatedAt),
    ],
  );

  const queueSchedules = schema.table(
    'schedules',
    {
      id: text().primaryKey().notNull(),
      task: text().notNull(),
      type: text().default('IMPERATIVE').notNull(),
      input: jsonb(),
      active: boolean().default(true).notNull(),
      cron: text().notNull(),
      timezone: text().default('UTC').notNull(),
      externalId: text('external_id'),
      deduplicationKey: text('deduplication_key'),
      meta: jsonb().$type<EnqueueMeta>().default({}).notNull(),
      nextRunAt: timestamp('next_run_at', {
        withTimezone: true,
        mode: 'string',
      }),
      lastRunAt: timestamp('last_run_at', {
        withTimezone: true,
        mode: 'string',
      }),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'string',
      })
        .defaultNow()
        .notNull(),
      updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'string',
      })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      index('queue_schedules_task_idx').on(table.task),
      index('queue_schedules_external_id_idx').on(table.externalId),
      index('queue_schedules_next_run_at_idx').on(table.nextRunAt),
      uniqueIndex('queue_schedules_deduplication_key_idx')
        .on(table.deduplicationKey)
        .where(sql`${table.deduplicationKey} IS NOT NULL`),
    ],
  );

  const queueScheduleInstances = schema.table(
    'schedule_instances',
    {
      id: text().primaryKey().notNull(),
      scheduleId: text('schedule_id')
        .notNull()
        .references(() => queueSchedules.id, { onDelete: 'cascade' }),
      active: boolean().default(true).notNull(),
      nextRunAt: timestamp('next_run_at', {
        withTimezone: true,
        mode: 'string',
      }),
      lastRunAt: timestamp('last_run_at', {
        withTimezone: true,
        mode: 'string',
      }),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'string',
      })
        .defaultNow()
        .notNull(),
      updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'string',
      })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      index('queue_schedule_instances_schedule_id_idx').on(table.scheduleId),
      index('queue_schedule_instances_next_run_at_idx').on(table.nextRunAt),
      uniqueIndex('queue_schedule_instances_schedule_id_unique').on(
        table.scheduleId,
      ),
    ],
  );

  const queueRuns = schema.table(
    'runs',
    {
      id: text().primaryKey().notNull(),
      transportJobId: text('transport_job_id'),
      task: text().notNull(),
      queue: text().notNull(),
      status: text().notNull(),
      input: jsonb(),
      output: jsonb(),
      error: jsonb(),
      meta: jsonb().$type<EnqueueMeta>().default({}).notNull(),
      metadata: jsonb().default({}).notNull(),
      tags: text().array().default([]).notNull(),
      scheduleId: text('schedule_id'),
      scheduleExternalId: text('schedule_external_id'),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'string',
      }).notNull(),
      startedAt: timestamp('started_at', {
        withTimezone: true,
        mode: 'string',
      }),
      finishedAt: timestamp('finished_at', {
        withTimezone: true,
        mode: 'string',
      }),
      updatedAt: timestamp('updated_at', {
        withTimezone: true,
        mode: 'string',
      })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      index('queue_runs_task_idx').on(table.task),
      index('queue_runs_transport_job_id_idx').on(table.transportJobId),
      index('queue_runs_status_idx').on(table.status),
      index('queue_runs_created_at_idx').on(table.createdAt),
      index('queue_runs_meta_idx').using('gin', table.meta),
      index('queue_runs_tags_idx').using('gin', table.tags),
      index('queue_runs_schedule_id_idx').on(table.scheduleId),
      index('queue_runs_schedule_external_id_idx').on(table.scheduleExternalId),
    ],
  );

  const queueRunEvents = schema.table(
    'run_events',
    {
      id: text().primaryKey().notNull(),
      runId: text('run_id')
        .notNull()
        .references(() => queueRuns.id, { onDelete: 'cascade' }),
      type: text().notNull(),
      data: jsonb().default({}).notNull(),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'string',
      })
        .defaultNow()
        .notNull(),
    },
    (table) => [
      index('queue_run_events_run_id_idx').on(table.runId),
      index('queue_run_events_created_at_idx').on(table.createdAt),
    ],
  );

  const queueRunSpans = schema.table(
    'run_spans',
    {
      id: text().primaryKey().notNull(),
      runId: text('run_id')
        .notNull()
        .references(() => queueRuns.id, { onDelete: 'cascade' }),
      attempt: integer().notNull(),
      traceId: text('trace_id').notNull(),
      spanId: text('span_id').notNull(),
      parentSpanId: text('parent_span_id'),
      kind: text().$type<'span' | 'log'>().notNull(),
      name: text().notNull(),
      level: text(),
      status: text(),
      error: jsonb().$type<{
        message: string;
        name?: string;
        stack?: string;
      }>(),
      startedAt: timestamp('started_at', {
        withTimezone: true,
        mode: 'string',
      }).notNull(),
      durationMs: integer('duration_ms'),
      attributes: jsonb().$type<Record<string, unknown>>(),
      createdAt: timestamp('created_at', {
        withTimezone: true,
        mode: 'string',
      })
        .defaultNow()
        .notNull(),
    },
    (table) => [index('queue_run_spans_run_id_idx').on(table.runId)],
  );

  const alertChannels = schema.table('alert_channels', {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    preset: text().$type<AlertContactPointPreset>().notNull(),
    url: text().notNull(),
    enabled: boolean().default(true).notNull(),
    displayName: text('display_name'),
    iconUrl: text('icon_url'),
    headers: jsonb().$type<Record<string, string>>(),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
  });

  const alertRules = schema.table('alert_rules', {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    enabled: boolean().default(true).notNull(),
    trigger: text().$type<AlertTrigger>().notNull(),
    severity: text().$type<AlertSeverity>().notNull(),
    queues: text().array().default([]).notNull(),
    jobNames: text('job_names').array().default([]).notNull(),
    threshold: integer(),
    contactPointIds: text('contact_point_ids').array().default([]).notNull(),
    cooldownMs: integer('cooldown_ms'),
    createdAt: timestamp('created_at', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', {
      withTimezone: true,
      mode: 'string',
    })
      .defaultNow()
      .notNull(),
  });

  return {
    queueCatalog,
    queueSchedules,
    queueScheduleInstances,
    queueRuns,
    queueRunEvents,
    queueRunSpans,
    alertChannels,
    alertRules,
  };
}

export function postgresAdapter(options: PostgresAdapterOptions): QueueStorage {
  const schema =
    typeof options.schema === 'string'
      ? defineQueueSchema({ schema: options.schema })
      : (options.schema ?? defineQueueSchema());
  const db = options.db as Transaction;

  return {
    publish: async (entries) => {
      await db.delete(schema.queueCatalog);
      if (entries.length === 0) return;
      await db.insert(schema.queueCatalog).values(entries.map(catalogValues));
    },

    resolve: async (id) => {
      const rows = (await db
        .select(catalogSelect(schema))
        .from(schema.queueCatalog)
        .where(eq(schema.queueCatalog.id, id))
        .limit(1)) as CatalogRow[];
      const [row] = rows;
      return row ? mapCatalog(row) : undefined;
    },

    read: async () => {
      const rows = (await db
        .select(catalogSelect(schema))
        .from(schema.queueCatalog)) as CatalogRow[];
      return rows.map(mapCatalog);
    },

    schedules: {
      create: async (input) => {
        const now = new Date().toISOString();
        const values = {
          id: input.id,
          task: input.task,
          type: input.type ?? 'IMPERATIVE',
          input: input.input,
          active: true,
          cron: input.cron,
          timezone: input.timezone,
          externalId: input.externalId,
          deduplicationKey: input.deduplicationKey,
          meta: input.meta ?? {},
          nextRunAt: input.nextRunAt.toISOString(),
          updatedAt: now,
        };

        let query = db.insert(schema.queueSchedules).values(values);

        if (input.deduplicationKey) {
          query = query.onConflictDoUpdate({
            target: schema.queueSchedules.deduplicationKey,
            targetWhere: sql`${schema.queueSchedules.deduplicationKey} IS NOT NULL`,
            set: {
              task: values.task,
              type: values.type,
              input: values.input,
              active: true,
              cron: values.cron,
              timezone: values.timezone,
              externalId: values.externalId,
              deduplicationKey: values.deduplicationKey,
              meta: values.meta,
              nextRunAt: values.nextRunAt,
              updatedAt: now,
            },
          });
        }

        const rows = (await query.returning(
          scheduleSelect(schema),
        )) as ScheduleRow[];
        const [row] = rows;
        if (!row) throw new Error('Failed to create queue schedule');

        await db
          .insert(schema.queueScheduleInstances)
          .values({
            id: `${row.id}:default`,
            scheduleId: row.id,
            active: true,
            nextRunAt: row.next_run_at,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: schema.queueScheduleInstances.scheduleId,
            set: {
              active: true,
              nextRunAt: row.next_run_at,
              updatedAt: now,
            },
          });

        return mapSchedule(row);
      },

      retrieve: (id) => findSchedule(db, schema, id),

      list: async (options) => {
        const filters = scheduleFilters(schema, options);
        let query = db
          .select(scheduleSelect(schema))
          .from(schema.queueSchedules);
        if (filters.length) query = query.where(and(...filters));
        query = query.orderBy(scheduleOrder(schema, options));
        if (options?.cursor) query = query.offset(cursorOffset(options.cursor));
        if (options?.limit) {
          query = query.limit(Math.min(Math.max(options.limit, 1), 500));
        }
        const rows = (await query) as ScheduleRow[];
        return rows.map(mapSchedule);
      },

      update: (id, input) => updateSchedule(db, schema, id, input),

      activate: async (id) => {
        const schedule = await updateSchedule(db, schema, id, {
          active: true,
        });
        if (schedule) await setInstanceActive(db, schema, id, true);
        return schedule;
      },

      deactivate: async (id) => {
        const schedule = await updateSchedule(db, schema, id, {
          active: false,
        });
        if (schedule) await setInstanceActive(db, schema, id, false);
        return schedule;
      },

      delete: async (id) => {
        const deleted = (await db
          .delete(schema.queueSchedules)
          .where(eq(schema.queueSchedules.id, id))
          .returning({ id: schema.queueSchedules.id })) as Array<{
          id: string;
        }>;
        return deleted.length > 0;
      },

      complete: async (id, lastRunAt, nextRunAt) => {
        const schedule = await updateSchedule(db, schema, id, {
          lastRunAt,
          nextRunAt,
        });
        return schedule;
      },
    },

    runs: {
      list: (options) => listRuns(db, schema, options),
    },

    spans: {
      insertMany: async (spans) => {
        for (let i = 0; i < spans.length; i += SPAN_INSERT_CHUNK) {
          const chunk = spans.slice(i, i + SPAN_INSERT_CHUNK);
          await db.insert(schema.queueRunSpans).values(chunk.map(spanValues));
        }
      },
      listByRun: async (runId) => {
        const rows = (await db
          .select(spanSelect(schema))
          .from(schema.queueRunSpans)
          .where(eq(schema.queueRunSpans.runId, runId))
          .orderBy(asc(schema.queueRunSpans.startedAt))) as SpanRow[];
        return rows.map(mapSpan);
      },
    },

    alerts: postgresAlertStore({ db, schema }),

    handle: async (event) => {
      await persistRun(
        db,
        schema,
        event.run,
        event.type,
        event.type === 'progress' ? event.patch : {},
      );
    },
  };
}

export function postgresAlertStore(options: {
  db: unknown;
  schema?: string | QueueDrizzleSchema;
}): AlertStore {
  const schema =
    typeof options.schema === 'string'
      ? defineQueueSchema({ schema: options.schema })
      : (options.schema ?? defineQueueSchema());
  const db = options.db as Transaction;

  return {
    getContactPoints: async () => {
      const rows = (await db
        .select(alertChannelSelect(schema))
        .from(schema.alertChannels)) as AlertChannelRow[];
      return rows
        .map(mapContactPoint)
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    getContactPoint: async (id) => {
      const rows = (await db
        .select(alertChannelSelect(schema))
        .from(schema.alertChannels)
        .where(eq(schema.alertChannels.id, id))
        .limit(1)) as AlertChannelRow[];
      const [row] = rows;
      return row ? mapContactPoint(row) : undefined;
    },

    createContactPoint: async (input) => {
      const now = new Date().toISOString();
      const rows = (await db
        .insert(schema.alertChannels)
        .values({
          ...input,
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        })
        .returning(alertChannelSelect(schema))) as AlertChannelRow[];
      return mapContactPoint(rows[0]!);
    },

    updateContactPoint: async (id, input) => {
      const set = contactPointSet(input);
      if (Object.keys(set).length === 1) return undefined;
      const rows = (await db
        .update(schema.alertChannels)
        .set(set)
        .where(eq(schema.alertChannels.id, id))
        .returning(alertChannelSelect(schema))) as AlertChannelRow[];
      const [row] = rows;
      return row ? mapContactPoint(row) : undefined;
    },

    deleteContactPoint: async (id) => {
      const rows = (await db
        .delete(schema.alertChannels)
        .where(eq(schema.alertChannels.id, id))
        .returning({ id: schema.alertChannels.id })) as Array<{ id: string }>;
      return rows.length > 0;
    },

    getRules: async () => {
      const rows = (await db
        .select(alertRuleSelect(schema))
        .from(schema.alertRules)) as AlertRuleRow[];
      return rows.map(mapRule).sort((a, b) => a.name.localeCompare(b.name));
    },

    getRule: async (id) => {
      const rows = (await db
        .select(alertRuleSelect(schema))
        .from(schema.alertRules)
        .where(eq(schema.alertRules.id, id))
        .limit(1)) as AlertRuleRow[];
      const [row] = rows;
      return row ? mapRule(row) : undefined;
    },

    createRule: async (input) => {
      const now = new Date().toISOString();
      const rows = (await db
        .insert(schema.alertRules)
        .values({
          ...input,
          id: crypto.randomUUID(),
          queues: input.queues ?? [],
          jobNames: input.jobNames ?? [],
          threshold: input.threshold ?? null,
          cooldownMs: input.cooldownMs ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning(alertRuleSelect(schema))) as AlertRuleRow[];
      return mapRule(rows[0]!);
    },

    updateRule: async (id, input) => {
      const set = ruleSet(input);
      if (Object.keys(set).length === 1) return undefined;
      const rows = (await db
        .update(schema.alertRules)
        .set(set)
        .where(eq(schema.alertRules.id, id))
        .returning(alertRuleSelect(schema))) as AlertRuleRow[];
      const [row] = rows;
      return row ? mapRule(row) : undefined;
    },

    deleteRule: async (id) => {
      const rows = (await db
        .delete(schema.alertRules)
        .where(eq(schema.alertRules.id, id))
        .returning({ id: schema.alertRules.id })) as Array<{ id: string }>;
      return rows.length > 0;
    },
  };
}

function catalogValues(entry: QueueCatalogEntry) {
  return {
    id: entry.id,
    name: entry.name,
    queue: entry.queue,
    attempts: entry.attempts,
    backoff: entry.backoff,
    concurrency: entry.concurrency,
    ttl: entry.ttl,
    maxStalledCount: entry.maxStalledCount,
    cron: entry.cron,
    tags: entry.tags,
    description: entry.description,
    schemaMetadata: entry.schema,
    updatedAt: entry.updatedAt,
    version: entry.version,
  };
}

function catalogSelect(schema: QueueDrizzleSchema) {
  return {
    id: schema.queueCatalog.id,
    name: schema.queueCatalog.name,
    queue: schema.queueCatalog.queue,
    attempts: schema.queueCatalog.attempts,
    backoff: schema.queueCatalog.backoff,
    concurrency: schema.queueCatalog.concurrency,
    ttl: schema.queueCatalog.ttl,
    max_stalled_count: schema.queueCatalog.maxStalledCount,
    cron: schema.queueCatalog.cron,
    tags: schema.queueCatalog.tags,
    description: schema.queueCatalog.description,
    schema: schema.queueCatalog.schemaMetadata,
    updated_at: schema.queueCatalog.updatedAt,
    version: schema.queueCatalog.version,
  };
}

function scheduleSelect(schema: QueueDrizzleSchema) {
  return {
    id: schema.queueSchedules.id,
    task: schema.queueSchedules.task,
    type: schema.queueSchedules.type,
    input: schema.queueSchedules.input,
    active: schema.queueSchedules.active,
    cron: schema.queueSchedules.cron,
    timezone: schema.queueSchedules.timezone,
    external_id: schema.queueSchedules.externalId,
    deduplication_key: schema.queueSchedules.deduplicationKey,
    meta: schema.queueSchedules.meta,
    next_run_at: schema.queueSchedules.nextRunAt,
    last_run_at: schema.queueSchedules.lastRunAt,
    created_at: schema.queueSchedules.createdAt,
    updated_at: schema.queueSchedules.updatedAt,
  };
}

function runSelect(schema: QueueDrizzleSchema) {
  return {
    id: schema.queueRuns.id,
    transport_job_id: schema.queueRuns.transportJobId,
    task: schema.queueRuns.task,
    queue: schema.queueRuns.queue,
    status: schema.queueRuns.status,
    input: schema.queueRuns.input,
    output: schema.queueRuns.output,
    error: schema.queueRuns.error,
    meta: schema.queueRuns.meta,
    metadata: schema.queueRuns.metadata,
    tags: schema.queueRuns.tags,
    schedule_id: schema.queueRuns.scheduleId,
    schedule_external_id: schema.queueRuns.scheduleExternalId,
    created_at: schema.queueRuns.createdAt,
    started_at: schema.queueRuns.startedAt,
    finished_at: schema.queueRuns.finishedAt,
    updated_at: schema.queueRuns.updatedAt,
  };
}

function spanSelect(schema: QueueDrizzleSchema) {
  return {
    id: schema.queueRunSpans.id,
    run_id: schema.queueRunSpans.runId,
    attempt: schema.queueRunSpans.attempt,
    trace_id: schema.queueRunSpans.traceId,
    span_id: schema.queueRunSpans.spanId,
    parent_span_id: schema.queueRunSpans.parentSpanId,
    kind: schema.queueRunSpans.kind,
    name: schema.queueRunSpans.name,
    level: schema.queueRunSpans.level,
    status: schema.queueRunSpans.status,
    error: schema.queueRunSpans.error,
    started_at: schema.queueRunSpans.startedAt,
    duration_ms: schema.queueRunSpans.durationMs,
    attributes: schema.queueRunSpans.attributes,
  };
}

function alertChannelSelect(schema: QueueDrizzleSchema) {
  return {
    id: schema.alertChannels.id,
    name: schema.alertChannels.name,
    preset: schema.alertChannels.preset,
    url: schema.alertChannels.url,
    enabled: schema.alertChannels.enabled,
    display_name: schema.alertChannels.displayName,
    icon_url: schema.alertChannels.iconUrl,
    headers: schema.alertChannels.headers,
    created_at: schema.alertChannels.createdAt,
    updated_at: schema.alertChannels.updatedAt,
  };
}

function alertRuleSelect(schema: QueueDrizzleSchema) {
  return {
    id: schema.alertRules.id,
    name: schema.alertRules.name,
    enabled: schema.alertRules.enabled,
    trigger: schema.alertRules.trigger,
    severity: schema.alertRules.severity,
    queues: schema.alertRules.queues,
    job_names: schema.alertRules.jobNames,
    threshold: schema.alertRules.threshold,
    contact_point_ids: schema.alertRules.contactPointIds,
    cooldown_ms: schema.alertRules.cooldownMs,
    created_at: schema.alertRules.createdAt,
    updated_at: schema.alertRules.updatedAt,
  };
}

function mapCatalog(row: CatalogRow): QueueCatalogEntry {
  return {
    id: row.id,
    name: row.name,
    queue: row.queue,
    attempts: row.attempts,
    backoff: row.backoff,
    concurrency: row.concurrency,
    ttl: row.ttl ?? undefined,
    maxStalledCount: row.max_stalled_count ?? undefined,
    cron: row.cron ?? undefined,
    tags: row.tags,
    description: row.description ?? undefined,
    schema: row.schema ?? undefined,
    updatedAt: date(row.updated_at).toISOString(),
    version: row.version,
  };
}

function mapRun(row: RunRow): QueueRun {
  return {
    id: row.id,
    transportJobId: row.transport_job_id ?? undefined,
    task: row.task,
    queue: row.queue,
    status: row.status,
    input: row.input,
    output: row.output ?? undefined,
    error: row.error ?? undefined,
    meta: row.meta ?? {},
    metadata: row.metadata ?? {},
    tags: row.tags,
    scheduleId: row.schedule_id ?? undefined,
    scheduleExternalId: row.schedule_external_id ?? undefined,
    createdAt: date(row.created_at),
    startedAt: optionalDate(row.started_at),
    finishedAt: optionalDate(row.finished_at),
    updatedAt: date(row.updated_at),
  };
}

function mapSpan(row: SpanRow): QueueRunSpan {
  return {
    id: row.id,
    runId: row.run_id,
    attempt: row.attempt,
    traceId: row.trace_id,
    spanId: row.span_id,
    parentSpanId: row.parent_span_id ?? undefined,
    kind: row.kind,
    name: row.name,
    level: row.level ?? undefined,
    status:
      row.status === 'ok' || row.status === 'error' ? row.status : undefined,
    error: row.error ?? undefined,
    startedAt: date(row.started_at),
    durationMs: row.duration_ms ?? undefined,
    attributes: row.attributes ?? undefined,
  };
}

function mapContactPoint(row: AlertChannelRow): AlertContactPoint {
  return {
    id: row.id,
    name: row.name,
    preset: row.preset,
    url: row.url,
    enabled: row.enabled,
    displayName: row.display_name ?? undefined,
    iconUrl: row.icon_url ?? undefined,
    headers: row.headers ?? undefined,
    createdAt: date(row.created_at).getTime(),
    updatedAt: date(row.updated_at).getTime(),
  };
}

function mapRule(row: AlertRuleRow): AlertRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    trigger: row.trigger,
    severity: row.severity,
    queues: row.queues.length ? row.queues : undefined,
    jobNames: row.job_names.length ? row.job_names : undefined,
    threshold: row.threshold ?? undefined,
    contactPointIds: row.contact_point_ids,
    cooldownMs: row.cooldown_ms ?? undefined,
    createdAt: date(row.created_at).getTime(),
    updatedAt: date(row.updated_at).getTime(),
  };
}

function mapSchedule(row: ScheduleRow): QueueSchedule {
  return {
    id: row.id,
    type: row.type === 'DECLARATIVE' ? 'DECLARATIVE' : 'IMPERATIVE',
    input: row.input ?? undefined,
    task: row.task,
    active: row.active,
    cron: row.cron,
    timezone: row.timezone,
    externalId: row.external_id ?? undefined,
    deduplicationKey: row.deduplication_key ?? undefined,
    meta: row.meta ?? {},
    nextRun: optionalDate(row.next_run_at),
    lastRun: optionalDate(row.last_run_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

async function findSchedule(
  db: Transaction,
  schema: QueueDrizzleSchema,
  id: string,
): Promise<QueueSchedule | undefined> {
  const rows = (await db
    .select(scheduleSelect(schema))
    .from(schema.queueSchedules)
    .where(eq(schema.queueSchedules.id, id))
    .limit(1)) as ScheduleRow[];
  const [row] = rows;
  return row ? mapSchedule(row) : undefined;
}

async function updateSchedule(
  db: Transaction,
  schema: QueueDrizzleSchema,
  id: string,
  input: QueueScheduleUpdateInput & {
    active?: boolean;
    lastRunAt?: Date;
  },
): Promise<QueueSchedule | undefined> {
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.task !== undefined) set.task = input.task;
  if (input.type !== undefined) set.type = input.type;
  if (input.input !== undefined) set.input = input.input;
  if (input.cron !== undefined) set.cron = input.cron;
  if (input.timezone !== undefined) set.timezone = input.timezone;
  if (input.externalId !== undefined) set.externalId = input.externalId;
  if (input.deduplicationKey !== undefined) {
    set.deduplicationKey = input.deduplicationKey;
  }
  if (input.meta !== undefined) set.meta = input.meta;
  if (input.nextRunAt !== undefined) {
    set.nextRunAt = input.nextRunAt.toISOString();
  }
  if (input.lastRunAt !== undefined) {
    set.lastRunAt = input.lastRunAt.toISOString();
  }
  if (input.active !== undefined) set.active = input.active;

  const rows = (await db
    .update(schema.queueSchedules)
    .set(set)
    .where(eq(schema.queueSchedules.id, id))
    .returning(scheduleSelect(schema))) as ScheduleRow[];
  const [row] = rows;

  if (row && (input.nextRunAt !== undefined || input.lastRunAt !== undefined)) {
    const instanceSet: Record<string, unknown> = {
      updatedAt: new Date().toISOString(),
    };
    if (input.nextRunAt !== undefined) {
      instanceSet.nextRunAt = input.nextRunAt.toISOString();
    }
    if (input.lastRunAt !== undefined) {
      instanceSet.lastRunAt = input.lastRunAt.toISOString();
    }
    await db
      .update(schema.queueScheduleInstances)
      .set(instanceSet)
      .where(eq(schema.queueScheduleInstances.scheduleId, id));
  }

  return row ? mapSchedule(row) : undefined;
}

async function setInstanceActive(
  db: Transaction,
  schema: QueueDrizzleSchema,
  scheduleId: string,
  active: boolean,
) {
  await db
    .update(schema.queueScheduleInstances)
    .set({ active, updatedAt: new Date().toISOString() })
    .where(eq(schema.queueScheduleInstances.scheduleId, scheduleId));
}

function scheduleFilters(
  schema: QueueDrizzleSchema,
  options: QueueScheduleListOptions | undefined,
) {
  const filters: SQL[] = [];
  if (options?.task) filters.push(eq(schema.queueSchedules.task, options.task));
  if (options?.externalId) {
    filters.push(eq(schema.queueSchedules.externalId, options.externalId));
  }
  if (options?.active !== undefined) {
    filters.push(eq(schema.queueSchedules.active, options.active));
  }
  if (options?.meta && Object.keys(options.meta).length > 0) {
    filters.push(metaContains(schema.queueSchedules.meta, options.meta));
  }
  return filters;
}

async function listRuns(
  db: Transaction,
  schema: QueueDrizzleSchema,
  options: QueueRunListOptions | undefined,
): Promise<QueueRunListResult> {
  const limit = Math.min(Math.max(options?.limit ?? 50, 1), 500);
  const offset = cursorOffset(options?.cursor);
  const filters = runFilters(schema, options);
  let query = db.select(runSelect(schema)).from(schema.queueRuns);
  if (filters.length) query = query.where(and(...filters));
  query = query
    .orderBy(runOrder(schema, options))
    .offset(offset)
    .limit(limit + 1);
  const rows = (await query) as RunRow[];
  const data = rows.slice(0, limit).map(mapRun);
  const hasMore = rows.length > limit;
  return {
    data,
    hasMore,
    cursor: hasMore ? String(offset + limit) : undefined,
  };
}

function runFilters(
  schema: QueueDrizzleSchema,
  options: QueueRunListOptions | undefined,
) {
  const filters: SQL[] = [];
  if (options?.id) filters.push(eq(schema.queueRuns.id, options.id));
  if (options?.task) filters.push(eq(schema.queueRuns.task, options.task));
  if (options?.status)
    filters.push(eq(schema.queueRuns.status, options.status));
  if (options?.scheduleId) {
    filters.push(eq(schema.queueRuns.scheduleId, options.scheduleId));
  }
  if (options?.scheduleExternalId) {
    filters.push(
      eq(schema.queueRuns.scheduleExternalId, options.scheduleExternalId),
    );
  }
  if (options?.meta && Object.keys(options.meta).length > 0) {
    filters.push(metaContains(schema.queueRuns.meta, options.meta));
  }
  if (options?.timeRange) {
    filters.push(
      gte(schema.queueRuns.createdAt, options.timeRange.start.toISOString()),
    );
    filters.push(
      lte(schema.queueRuns.createdAt, options.timeRange.end.toISOString()),
    );
  }
  return filters;
}

async function persistRun(
  db: Transaction,
  schema: QueueDrizzleSchema,
  run: QueueRunSnapshot,
  type: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const values = runValues(run);
  const { id: _id, createdAt: _createdAt, ...set } = values;
  await db.insert(schema.queueRuns).values(values).onConflictDoUpdate({
    target: schema.queueRuns.id,
    set,
  });
  await db.insert(schema.queueRunEvents).values({
    id: crypto.randomUUID(),
    runId: run.id,
    type,
    data,
  });
}

const SPAN_INSERT_CHUNK = 1000;

function spanValues(span: QueueRunSpan) {
  return {
    id: span.id,
    runId: span.runId,
    attempt: span.attempt,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    kind: span.kind,
    name: span.name,
    level: span.level,
    status: span.status,
    error: span.error,
    startedAt: span.startedAt.toISOString(),
    durationMs: span.durationMs,
    attributes: span.attributes,
  };
}

function runValues(run: QueueRunSnapshot) {
  const now = new Date().toISOString();
  return {
    id: run.id,
    transportJobId: run.transportJobId,
    task: run.name,
    queue: run.queue,
    status: run.status,
    input: run.input,
    output: run.output,
    error: run.error,
    meta: run.meta,
    metadata: run.metadata,
    tags: run.tags,
    scheduleId: run.scheduleId,
    scheduleExternalId: run.scheduleExternalId,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString(),
    finishedAt: run.finishedAt?.toISOString(),
    updatedAt: now,
  };
}

function contactPointSet(
  input: Partial<Omit<AlertContactPoint, 'id' | 'createdAt' | 'updatedAt'>>,
) {
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) set.name = input.name;
  if (input.preset !== undefined) set.preset = input.preset;
  if (input.url !== undefined) set.url = input.url;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.displayName !== undefined) set.displayName = input.displayName;
  if (input.iconUrl !== undefined) set.iconUrl = input.iconUrl;
  if (input.headers !== undefined) set.headers = input.headers;
  return set;
}

function ruleSet(
  input: Partial<Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>>,
) {
  const set: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (input.name !== undefined) set.name = input.name;
  if (input.enabled !== undefined) set.enabled = input.enabled;
  if (input.trigger !== undefined) set.trigger = input.trigger;
  if (input.severity !== undefined) set.severity = input.severity;
  if (input.queues !== undefined) set.queues = input.queues;
  if (input.jobNames !== undefined) set.jobNames = input.jobNames;
  if (input.threshold !== undefined) set.threshold = input.threshold;
  if (input.contactPointIds !== undefined) {
    set.contactPointIds = input.contactPointIds;
  }
  if (input.cooldownMs !== undefined) set.cooldownMs = input.cooldownMs;
  return set;
}

function scheduleOrder(
  schema: QueueDrizzleSchema,
  options: QueueScheduleListOptions | undefined,
) {
  const field = options?.sort?.field ?? 'nextRun';
  const direction = options?.sort?.direction ?? 'asc';
  const column = {
    nextRun: schema.queueSchedules.nextRunAt,
    lastRun: schema.queueSchedules.lastRunAt,
    createdAt: schema.queueSchedules.createdAt,
    updatedAt: schema.queueSchedules.updatedAt,
  }[field];
  return direction === 'asc' ? asc(column) : desc(column);
}

function runOrder(
  schema: QueueDrizzleSchema,
  options: QueueRunListOptions | undefined,
) {
  const field = options?.sort?.field ?? 'createdAt';
  const direction = options?.sort?.direction ?? 'desc';
  const column = {
    createdAt: schema.queueRuns.createdAt,
    startedAt: schema.queueRuns.startedAt,
    finishedAt: schema.queueRuns.finishedAt,
    updatedAt: schema.queueRuns.updatedAt,
  }[field];
  return direction === 'asc' ? asc(column) : desc(column);
}

function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number(cursor);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function metaContains(column: unknown, meta: Record<string, unknown>) {
  return sql`${column} @> ${JSON.stringify(meta)}::jsonb`;
}

function optionalDate(
  value: Date | string | null | undefined,
): Date | undefined {
  return value ? date(value) : undefined;
}

function date(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
