import type { BackoffOptions } from '@openqueue/core/types';
import {
  type ActiveTransportJob,
  type ConsumeOptions,
  type QueueTransport,
  type TransportCapabilities,
  type TransportConsumer,
  type TransportFlowNode,
  type TransportJobHandle,
  type TransportJobSpec,
  UnsupportedCapabilityError,
} from '@openqueue/core/world';
import type postgres from 'postgres';

/**
 * A `SELECT ... FOR UPDATE SKIP LOCKED` delivery transport over the single
 * `openqueue.jobs` table. It pins the same behaviour the local/BullMQ transports
 * give core: `attemptsMade` is 0 inside `process()` and 1-based in callbacks;
 * `onFailed` fires every attempt with `final = isFinal(err)`; `updateData`
 * persists across retries; a settled job leaves the table (retention is a
 * no-op). `flows` is unsupported — `enqueueFlow` throws a typed
 * {@link UnsupportedCapabilityError}, which core enforces before it is reached.
 *
 * `updateProgress` and `log` are in-process no-ops: durable progress already
 * travels through `updateData(__metadata)`, and pg-world observability is
 * console + OTel rather than a job-log stream.
 */
export interface PostgresTransportPollOptions {
  /** Idle poll interval; a non-empty batch re-polls immediately. Default 500ms. */
  intervalMs?: number;
  /** Max rows claimed per poll (also capped by remaining concurrency). Default 10. */
  batch?: number;
}

export interface PostgresTransportStallOptions {
  /** How long a claim survives without a heartbeat before it can be recovered. Default 30000ms. */
  visibilityMs?: number;
  /** Heartbeat interval that extends live claims. Default 10000ms. */
  heartbeatMs?: number;
}

export interface CreatePostgresTransportOptions {
  sql: postgres.Sql;
  namespace: string;
  poll?: PostgresTransportPollOptions;
  stall?: PostgresTransportStallOptions;
}

const capabilities: TransportCapabilities = {
  delay: true,
  priority: true,
  flows: false,
  deduplication: true,
  remove: true,
};

interface ClaimedRow {
  id: string;
  name: string;
  data: unknown;
  attempts: number;
  attempts_made: number;
  backoff: BackoffOptions | number | null;
  // A drizzle store query on the shared client disables postgres.js's timestamp
  // parser, so these arrive as strings once the store has run — coerce with toDate.
  created_at: Date | string;
  processed_on: Date | string;
}

interface HandleRow {
  id: string;
  name: string;
  data: unknown;
  attempts: number;
  attempts_made: number;
}

interface StalledRow {
  id: string;
  name: string;
  data: unknown;
  attempts: number;
  attempts_made: number;
}

interface JobState {
  data: unknown;
  attemptsMade: number;
  returnvalue: unknown;
  finishedOn?: number;
}

interface PgConsumer {
  queue: string;
  options: ConsumeOptions;
  concurrency: number;
  maxStalled: number;
  inFlight: Map<string, Promise<void>>;
  closed: boolean;
  wake: () => void;
  heartbeat: ReturnType<typeof setInterval>;
  loop: Promise<void>;
}

const NOOP = (): void => {};

export function createPostgresTransport(
  options: CreatePostgresTransportOptions,
): QueueTransport {
  const { sql, namespace } = options;
  const intervalMs = options.poll?.intervalMs ?? 500;
  const batch = options.poll?.batch ?? 10;
  const visibilityMs = options.stall?.visibilityMs ?? 30_000;
  const heartbeatMs = options.stall?.heartbeatMs ?? 10_000;

  const consumers = new Set<PgConsumer>();
  let closed = false;

  // now() + <ms> as an interval, unambiguous across argument orders.
  const seconds = (ms: number) =>
    sql`interval '1 second' * (${ms}::double precision / 1000)`;

  async function enqueue(
    queue: string,
    spec: TransportJobSpec,
  ): Promise<{ jobId: string }> {
    await sql`
      insert into "openqueue"."jobs"
        (namespace, queue, id, name, data, priority, attempts, backoff, state, run_at)
      values (
        ${namespace}, ${queue}, ${spec.id}, ${spec.name}, ${jsonText(spec.data)}::text::jsonb,
        ${spec.priority ?? 0}, ${spec.attempts ?? 1}, ${jsonText(spec.backoff)}::text::jsonb,
        'waiting', now() + ${seconds(spec.delay ?? 0)}
      )
      on conflict (namespace, queue, id) do nothing
    `;
    return { jobId: spec.id };
  }

  async function getJob(
    queue: string,
    id: string,
  ): Promise<TransportJobHandle | undefined> {
    const rows = await sql<HandleRow[]>`
      select id, name, data, attempts, attempts_made
      from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue} and id = ${id}
      limit 1
    `;
    const row = rows[0];
    return row ? buildHandle(queue, row) : undefined;
  }

  async function listDelayed(queue: string): Promise<TransportJobHandle[]> {
    const rows = await sql<HandleRow[]>`
      select id, name, data, attempts, attempts_made
      from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue}
        and state = 'waiting' and run_at > now()
    `;
    return rows.map((row) => buildHandle(queue, row));
  }

  function buildHandle(queue: string, row: HandleRow): TransportJobHandle {
    return {
      name: row.name,
      data: row.data,
      attemptsMade: row.attempts_made,
      opts: { attempts: row.attempts },
      remove: () => remove(queue, row.id),
    };
  }

  async function remove(queue: string, id: string): Promise<void> {
    const deleted = await sql`
      delete from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue} and id = ${id}
        and not (state = 'active' and claimed_until > now())
      returning id
    `;
    if (deleted.length > 0) return;
    const active = await sql`
      select 1 from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue} and id = ${id}
      limit 1
    `;
    if (active.length > 0) {
      throw new Error(
        `@openqueue/world-postgres: job "${id}" is active and cannot be removed`,
      );
    }
  }

  async function deleteJob(queue: string, id: string): Promise<void> {
    await sql`
      delete from "openqueue"."jobs"
      where namespace = ${namespace} and queue = ${queue} and id = ${id}
    `;
  }

  async function requeue(
    queue: string,
    id: string,
    attemptsMade: number,
    delayMs: number,
  ): Promise<void> {
    await sql`
      update "openqueue"."jobs"
      set state = 'waiting',
          attempts_made = ${attemptsMade},
          run_at = now() + ${seconds(delayMs)},
          claimed_until = null
      where namespace = ${namespace} and queue = ${queue} and id = ${id}
    `;
  }

  async function persistData(
    queue: string,
    id: string,
    data: unknown,
  ): Promise<void> {
    await sql`
      update "openqueue"."jobs"
      set data = ${jsonText(data)}::text::jsonb
      where namespace = ${namespace} and queue = ${queue} and id = ${id}
    `;
  }

  async function claim(queue: string, limit: number): Promise<ClaimedRow[]> {
    return sql<ClaimedRow[]>`
      update "openqueue"."jobs" as j
      set state = 'active',
          claimed_until = now() + ${seconds(visibilityMs)},
          processed_on = coalesce(j.processed_on, now())
      where (j.namespace, j.queue, j.id) in (
        select c.namespace, c.queue, c.id
        from "openqueue"."jobs" as c
        where c.namespace = ${namespace} and c.queue = ${queue}
          and c.state = 'waiting' and c.run_at <= now()
        order by c.priority asc, c.seq asc
        limit ${limit}
        for update skip locked
      )
      returning j.id, j.name, j.data, j.attempts, j.attempts_made,
                j.backoff, j.created_at, j.processed_on
    `;
  }

  async function stallPass(consumer: PgConsumer): Promise<void> {
    // Recover recoverable stalls back to waiting (attempts_made unchanged — a
    // stall is not a failed attempt); SKIP LOCKED keeps two consumers off one row.
    await sql`
      update "openqueue"."jobs"
      set state = 'waiting', stalled_count = stalled_count + 1, claimed_until = null
      where (namespace, queue, id) in (
        select namespace, queue, id from "openqueue"."jobs"
        where namespace = ${namespace} and queue = ${consumer.queue}
          and state = 'active' and claimed_until < now()
          and stalled_count < ${consumer.maxStalled}
        for update skip locked
      )
    `;
    const failed = await sql<StalledRow[]>`
      delete from "openqueue"."jobs"
      where (namespace, queue, id) in (
        select namespace, queue, id from "openqueue"."jobs"
        where namespace = ${namespace} and queue = ${consumer.queue}
          and state = 'active' and claimed_until < now()
          and stalled_count >= ${consumer.maxStalled}
        for update skip locked
      )
      returning id, name, data, attempts, attempts_made
    `;
    for (const row of failed) {
      const job = buildStalledJob(consumer.queue, row);
      await runCallback(consumer, () =>
        consumer.options.onFailed(job, stallError(row.id), { final: true }),
      );
    }
  }

  function buildActiveJob(
    queue: string,
    row: ClaimedRow,
    state: JobState,
  ): ActiveTransportJob {
    return {
      id: row.id,
      name: row.name,
      queueName: queue,
      timestamp: toDate(row.created_at).getTime(),
      processedOn: toDate(row.processed_on).getTime(),
      opts: { attempts: row.attempts },
      get data() {
        return state.data;
      },
      get attemptsMade() {
        return state.attemptsMade;
      },
      get finishedOn() {
        return state.finishedOn;
      },
      get returnvalue() {
        return state.returnvalue;
      },
      updateData: async (data) => {
        state.data = data;
        await persistData(queue, row.id, data);
      },
      updateProgress: async () => undefined,
      log: async () => 0,
    };
  }

  function buildStalledJob(queue: string, row: StalledRow): ActiveTransportJob {
    return {
      id: row.id,
      name: row.name,
      queueName: queue,
      timestamp: Date.now(),
      opts: { attempts: row.attempts },
      data: row.data,
      attemptsMade: row.attempts_made,
      returnvalue: undefined,
      updateData: async () => undefined,
      updateProgress: async () => undefined,
      log: async () => 0,
    };
  }

  function startJob(consumer: PgConsumer, row: ClaimedRow): void {
    const state: JobState = {
      data: row.data,
      attemptsMade: row.attempts_made,
      returnvalue: undefined,
    };
    const job = buildActiveJob(consumer.queue, row, state);
    const promise = processAndSettle(consumer, row, job, state)
      .catch((err) => runOnError(consumer, err))
      .finally(() => {
        consumer.inFlight.delete(row.id);
        consumer.wake();
      });
    consumer.inFlight.set(row.id, promise);
  }

  async function processAndSettle(
    consumer: PgConsumer,
    row: ClaimedRow,
    job: ActiveTransportJob,
    state: JobState,
  ): Promise<void> {
    const { options } = consumer;
    let ok = false;
    let value: unknown;
    let error: unknown;
    try {
      value = await options.process(job);
      ok = true;
    } catch (err) {
      error = err;
    }

    state.attemptsMade = row.attempts_made + 1;
    state.finishedOn = Date.now();

    if (ok) {
      state.returnvalue = value;
      await deleteJob(consumer.queue, row.id);
      await runCallback(consumer, () => options.onCompleted(job));
      return;
    }

    const final = options.isFinal(error);
    const willRetry = !final && state.attemptsMade < (row.attempts ?? 1);
    if (willRetry) {
      await requeue(
        consumer.queue,
        row.id,
        state.attemptsMade,
        retryDelay(row.backoff, state.attemptsMade),
      );
    } else {
      await deleteJob(consumer.queue, row.id);
    }
    await runCallback(consumer, () => options.onFailed(job, error, { final }));
  }

  async function runLoop(consumer: PgConsumer): Promise<void> {
    while (!consumer.closed && !closed) {
      try {
        await stallPass(consumer);
      } catch (err) {
        runOnError(consumer, err);
      }

      const capacity = consumer.concurrency - consumer.inFlight.size;
      if (capacity <= 0) {
        await waitForWork(consumer);
        continue;
      }

      let rows: ClaimedRow[];
      try {
        rows = await claim(consumer.queue, Math.min(batch, capacity));
      } catch (err) {
        runOnError(consumer, err);
        await waitForWork(consumer);
        continue;
      }

      if (rows.length === 0) {
        await waitForWork(consumer);
        continue;
      }
      for (const row of rows) startJob(consumer, row);
      // Non-empty batch → re-poll immediately (throughput is not poll-bound).
    }
  }

  function waitForWork(consumer: PgConsumer): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        consumer.wake = NOOP;
        resolve();
      }, intervalMs);
      consumer.wake = () => {
        clearTimeout(timer);
        consumer.wake = NOOP;
        resolve();
      };
    });
  }

  async function heartbeat(consumer: PgConsumer): Promise<void> {
    const ids = [...consumer.inFlight.keys()];
    if (ids.length === 0) return;
    try {
      await sql`
        update "openqueue"."jobs"
        set claimed_until = now() + ${seconds(visibilityMs)}
        where namespace = ${namespace} and queue = ${consumer.queue}
          and state = 'active' and id = any(${sql.array(ids)})
      `;
    } catch (err) {
      runOnError(consumer, err);
    }
  }

  async function closeConsumer(consumer: PgConsumer): Promise<void> {
    consumer.closed = true;
    clearInterval(consumer.heartbeat);
    consumer.wake();
    await consumer.loop.catch(() => undefined);
    await Promise.allSettled([...consumer.inFlight.values()]);
    consumers.delete(consumer);
  }

  function consume(queue: string, opts: ConsumeOptions): TransportConsumer {
    const consumer: PgConsumer = {
      queue,
      options: opts,
      concurrency: opts.concurrency ?? 1,
      maxStalled: opts.maxStalledCount ?? 1,
      inFlight: new Map(),
      closed: false,
      wake: NOOP,
      heartbeat: setInterval(() => {
        void heartbeat(consumer);
      }, heartbeatMs),
      loop: Promise.resolve(),
    };
    consumers.add(consumer);
    consumer.loop = runLoop(consumer);
    return { close: () => closeConsumer(consumer) };
  }

  return {
    id: 'postgres',
    capabilities,
    enqueue,
    enqueueFlow: async (_node: TransportFlowNode) => {
      throw new UnsupportedCapabilityError('flows', 'postgres');
    },
    getJob,
    listDelayed,
    consume,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(
        [...consumers].map((consumer) => closeConsumer(consumer)),
      );
      consumers.clear();
      // Does not end `sql` — the world owns the connection.
    },
  };
}

function runCallback(
  consumer: PgConsumer,
  fn: () => Promise<void> | void,
): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .catch((err) => runOnError(consumer, err));
}

function runOnError(consumer: PgConsumer, err: unknown): void {
  try {
    consumer.options.onError(err);
  } catch {
    // A throwing onError must not unwind the poll loop.
  }
}

function stallError(id: string): Error {
  return new Error(
    `@openqueue/world-postgres: job "${id}" stalled and exceeded maxStalledCount`,
  );
}

/**
 * Serialize an arbitrary value to JSON text, or null for `undefined`. Callers
 * cast the result `::text::jsonb`: forcing text inference first stops postgres.js
 * from re-serializing the already-encoded string when a bare `::jsonb` would make
 * it infer (and double-encode) a jsonb parameter.
 */
function jsonText(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function retryDelay(
  backoff: BackoffOptions | number | null,
  attemptsMade: number,
): number {
  if (backoff === null) return 0;
  if (typeof backoff === 'number') return backoff;
  if (backoff.type === 'fixed') return backoff.delay;
  return Math.round(backoff.delay * 2 ** (attemptsMade - 1));
}
