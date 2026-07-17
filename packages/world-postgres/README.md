# @openqueue/world-postgres

A self-migrating **Postgres world** for [OpenQueue](https://github.com/quickbits-io/openqueue):
a `SELECT … FOR UPDATE SKIP LOCKED` delivery transport paired with a Drizzle-backed
durable store, over a single fixed `openqueue` schema — with **zero** Redis.

```ts
import { defineConfig } from '@openqueue/sdk';
import { worldPostgres } from '@openqueue/world-postgres';

export default defineConfig({
  namespace: 'my-app',
  dirs: ['./worker'],
  world: worldPostgres({
    url: process.env.DATABASE_URL!,
    migrations: 'auto', // apply pending migrations on boot; default is 'manual'
  }),
});
```

`world` is an XOR alternative to `redis` on the worker config — configure one or
the other, never both, and never a separate `storage` (the world owns it).

## Options

```ts
worldPostgres({
  url?: string,          // the world creates + owns the client, ends it on close
  db?: Sql,              // an existing postgres.js client; XOR with url, left open
  migrations?: 'auto' | 'manual', // default 'manual'
  poll?: { intervalMs?: number, batch?: number }, // default 500ms / 10
});
```

Provide exactly one of `url` or `db`.

## Migrations

The `openqueue` schema is created by embedded, committed migrations — not
`drizzle-kit`. Default mode is **manual**: a pending migration fails boot with an
actionable message. Apply it yourself with the CLI, then boot:

```bash
openqueue migrations print   # emits the SQL to stdout (no DB connection)
openqueue migrations status  # applied | pending | MISMATCH per step (exit 1 on mismatch)
```

Pipe `print` into `psql`, or set `migrations: 'auto'` to apply on boot. Auto mode
runs under a Postgres **advisory lock**, so N workers booting together apply the
schema exactly once. A committed migration whose checksum changed after it ran is
a hard failure — reconcile it by hand.

## Topology (v1)

- **One namespace per database.** The `jobs` delivery table is namespaced so N
  workers on one database never steal each other's jobs, but the store tables
  (catalog / schedules / runs / alerts) are namespace-blind — running two
  namespaces against one database makes catalog publishes last-writer-wins. Give
  each namespace its own database.
- **Poll latency.** Idle pickup is ≤ `intervalMs` (default 500ms); a non-empty
  claim re-polls immediately, so throughput is not poll-bound. `LISTEN/NOTIFY` is
  deliberately deferred (it breaks under connection poolers and injected clients).
- **`jobs` rows are delivery state only.** A row exists while a job is waiting or
  active and is deleted on completion or final failure. Run **history** lives in
  the `runs` table (read it via the `/openqueue/v1` control API or
  `@openqueue/client`) — the Workbench Runs page reads BullMQ and is empty on a
  postgres world.
- **No flows.** `flows` is unsupported; enqueuing a flow throws a typed
  `UnsupportedCapabilityError`. Observability is console + OTel (no job-log stream).

## Coexistence with `postgresAdapter`

`worldPostgres` and the `postgresAdapter` store are two different tools:

| | schema | migrations | scope |
| --- | --- | --- | --- |
| `worldPostgres` | fixed `openqueue` | embedded, self-applying | delivery **and** durable state |
| `postgresAdapter` | bring-your-own (`defineQueueSchema({ schema })`) | you own them (`drizzle-kit`) | durable state only (pairs with a Redis/BullMQ transport) |

They can share one database on **disjoint schemas** — e.g. `worldPostgres` on
`openqueue` and a `postgresAdapter` app store on `jobs`.

## Switching from BullMQ

Drain your BullMQ deployment first — **in-flight jobs do not transfer** between
worlds. Run history is portable per-table if you want it, once the `openqueue`
schema exists (boot a postgres worker once, or `openqueue migrations print`):

```sql
INSERT INTO "openqueue".runs        SELECT * FROM old_schema.runs;
INSERT INTO "openqueue".run_events  SELECT * FROM old_schema.run_events;
INSERT INTO "openqueue".schedules   SELECT * FROM old_schema.schedules;
-- …repeat per table you want to carry over
```

## Runtime

Node 18+ and Bun. Ships ESM + `.d.ts`. Depends only on `@openqueue/core`,
`drizzle-orm`, and `postgres` — no ioredis/bullmq.
