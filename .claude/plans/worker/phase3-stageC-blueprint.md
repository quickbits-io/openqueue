# Blueprint — Phase 3 Stage C: world-postgres + public surface

> Architect blueprint. TWO backend tasks: **C1** (core public surface + worker + workbench; gate = bullmq e2e unchanged) then **C2** (world-postgres package + CLI + e2e pg gate + release plumbing). This stage FREEZES the world/transport contracts — the C1 `index.d.ts` diff is the freeze artifact, review line-by-line.

## Design summary

1. **Core goes public by re-organizing, not re-designing**: split `src/world.ts` into an import-clean contract module (new `@openqueue/core/world` tsup entry/subpath) + internal `world-bullmq.ts`/`world-local.ts`; export factories + `UnsupportedCapabilityError` from index; `world` becomes an XOR alternative to `redis` on `QueueConfig` and `CreateQueueWorkerOptions`. `createQueueWorkerFromWorld` stays internal — public entry is `createQueueWorker`, extended.
2. **`@openqueue/world-postgres`**: SKIP LOCKED polling transport over one `openqueue.jobs` table; the store is literally `postgresAdapter({ db: drizzle(sql), schema: defineQueueSchema({ schema: 'openqueue' }) })` — zero new store code. Embedded maintainer-generated migrations + ~50-line advisory-lock runner in `world.start()`.
3. **The gate**: whole e2e suite re-runs as `E2E_WORLD=postgres` with a **poisoned `REDIS_URL=redis://127.0.0.1:9`** (any accidental ioredis use fails loudly), plus conformance (flows auto-skip) + migration-runner tests.

## Homework decisions (final)

1. **flows: `false` for transport-postgres v1 — confirmed.** Crash-safe SQL parent/child + three failure modes is real work, no demand signal. Core's landed gate already throws typed `UnsupportedCapabilityError` BEFORE drain hooks (`enqueue.ts:325-331`) — no phantom runs. e2e impact: none (no e2e test uses flows — verified). Conformance flow scenario self-skips.
2. **Conformance sharing: source-relative import** (`../../core/src/transport/conformance` from world-postgres tests). A subpath would ship a vitest-importing module in dist + freeze a harness API for one in-repo consumer. Promote later if third-party transports become real.
3. **updateData → `data` column** (persists across retries; row survives until terminal settlement). **updateProgress → in-memory** (durable progress already travels via `updateData(__metadata)`; BullMQ's separate progress only read by bullmq-scoped dashboard). **log() → no-op returning 0** (only log reader is `qm.getJobLogs` → BullMQ — bullmq-scoped; pg-world observability = console + OTel; documented). **attempts_made column** incremented on settlement (0-based in process(), includes current in callbacks — exact parity). `processed_on` COALESCEd on first claim.
4. **Schedule ticks map cleanly**: enqueueNext → row with `run_at = now()+delay`; listDelayed = `state='waiting' AND run_at > now()`; remove via handle. Actively-firing tick not in delayed set (BullMQ parity); `fire()`'s nextRun match discards stale ticks. Schedule queue namespace-prefixed.
5. **Pure polling v1**: `poll: { intervalMs = 500, batch = 10 }`. Idle pickup ≤500ms worst case; non-empty batch → immediate re-poll (throughput not poll-bound). LISTEN/NOTIFY deferred (dedicated-connection breaks under poolers/injected clients).
6. **Pre-freeze amendments (do in C1 — last chance)**: (a) `OpenQueueWorld` gains `migrations?: WorldMigrations`; (b) `WorldBullmqOptions` drops dead `NamespaceOptions` extension, gains `{ url }` alternative (world owns + quits internally-created clients on close); (c) everything else freezes as-is (TransportJobSpec incl. opaque ttl, TransportJobHandle without id, ActiveTransportJob, ConsumeOptions, validateWorld, WORLD_SPEC_VERSION=1); (d) flagged not changed: `createQueueClientFromWorld` doesn't call `world.start?.()` — correct while the worker is sole migration runner; Stage D decides its posture.

## Affected packages

core (public world surface), **world-postgres (NEW)**, worker (validateConfig world XOR redis + boot branch + zero-queue wiring), workbench (WorkbenchCore accepts explicit empty queues), cli (migrations print|status), sdk (auto via export *; d.ts grows), client untouched, e2e (world mode), root (scripts/turbo/release-please).

---

## Task C1 — core public surface

### packages/core

**MOD `src/world.ts`** → contract-only module (new tsup entry `world: 'src/world.ts'` → `@openqueue/core/world` export in package.json). Import-clean: only `./transport/types` + type-only `./types`/`./namespace`. Adds:

```ts
export interface WorldMigrationStep { id: string; checksum: string; sql: string }
export type WorldMigrationState = 'applied' | 'pending' | 'checksum_mismatch';
export interface WorldMigrationStatus { id: string; state: WorldMigrationState; appliedAt?: Date }
export interface WorldMigrations {
  steps: readonly WorldMigrationStep[];
  status(): Promise<WorldMigrationStatus[]>;
}
export interface OpenQueueWorld {
  specVersion: number; transport: QueueTransport; store: QueueStorage;
  migrations?: WorldMigrations;      // NEW
  start?(): Promise<void>; close(): Promise<void>;
}
// + re-export UnsupportedCapabilityError and ALL transport contract types so ./world is self-sufficient
```

**NEW `src/world-bullmq.ts`** — `worldBullmq` + catalog-composition helpers move verbatim (they import ioredis — must not sit on ./world entry). Options:

```ts
export type WorldBullmqOptions = (
  | { url: string; producer?: undefined; consumer?: undefined }
  | { producer: Redis; consumer?: Redis; url?: undefined }
) & { storage?: QueueStorage; catalogFallbacks?: QueueCatalogStore[] };
// url form: create producer+consumer internally (lazyConnect), quit in world.close()
```

**NEW `src/world-local.ts`** — `worldLocal()` moves unchanged.

**MOD `src/runtime.ts`** — `CreateQueueWorkerOptions` becomes a discriminated union: `CreateQueueWorkerRedisOptions` (redis required, catalog?/storage?, `world?: undefined`) | `CreateQueueWorkerWorldOptions` (world: WorldFactory, `redis?: undefined` — storage/catalog deliberately absent: the world owns them). `createQueueWorker`: `if (options.world)` → `validateWorld(await options.world({ namespace }))` → delegate to existing `createQueueWorkerFromWorld`. Redis path byte-identical.

**MOD `src/config.ts`** — `redis` becomes optional; `world?: WorldFactory` added (type-only import).

**MOD `src/index.ts`** — export `UnsupportedCapabilityError, validateWorld, WORLD_SPEC_VERSION` + all world/transport types (OpenQueueWorld, QueueTransport, TransportCapabilities/Capability, ActiveTransportJob, ConsumeOptions, TransportConsumer/FlowNode/JobHandle/JobSpec/Retention, WorldContext/Factory/Migrations/MigrationStatus/MigrationStep) + `worldBullmq`/`WorldBullmqOptions` + `worldLocal`.

**NEW `src/__tests__/world-public.test.ts`** — `createQueueWorker({ world: worldLocal(), tasks })`: trigger→run→list completed; declarative schedule synced; close clean. Redis-gated: `worldBullmq({ url })` ownership (close quits internal clients).

### packages/worker

**MOD `src/index.ts`** — `validateConfig` returns `ValidatedBackend = { world } | { redis }` (world XOR redis; both/neither → error; world+storage → error "the world owns durable state; configure it inside the world factory"; existing rules unchanged). Boot branches on it. `createWorkbenchForRuntime`: `prefix: config.redis?.bullPrefix ?? 'bull'`; `alerts.persistence: storage→'postgres' | world→'custom' | 'redis'`. Log when workbench enabled + `runtime.queues.size === 0`: `[openqueue] workbench: no BullMQ queues on this world — queue/run pages will be empty; use /openqueue/v1 for run history`.

**MOD `src/config-validation.test.ts`** — world+redis rejected; neither rejected; world+storage rejected; world-only accepted (worldLocal + noop task, full boot, no services).

### packages/workbench

**MOD `src/core/workbench.ts`** — allow explicit empty queues: `if (opts.queues === undefined && !this.options.redis) throw ...`. Downstream already zero-queue-safe (verified). **NEW `src/core/workbench-empty.test.ts`** — constructs with `{ queues: [], registry, queue: { schedules } }`; getConfig sane; /api/queues → []; /overview 200; /api/test delegates; `new WorkbenchCore({})` still throws.

### Degradation matrix (document in C1 PR + docs — CODE truth, corrects the phase blueprint's guess)

Works on non-bullmq worlds: shell/config/auth; test enqueue (registry → runtime.trigger); dynamic schedules CRUD; alerts CRUD (store = world store). Inert: alert FIRING (evaluates BullMQ metrics). **Empty: Runs page (`qm.getAllRuns` reads BullMQ, NOT the core store — run history for pg worlds = control API/client)**; overview/counts/metrics/errors/activity/search/tags (zeros); queue pages, job detail/logs/spans, retry/remove/promote/clean/bulk/pause (raw BullMQ); repeatable schedulers; Prometheus metrics.

### C1 verification
1. core: typecheck+test; `types.d.ts`/`drizzle.d.ts` byte-stable; `index.d.ts` grows by EXACTLY the listed exports (audit the diff — it's the freeze artifact).
2. Import-clean gate (wire into CI/e2e): `bun build packages/core/dist/world.js --bundle` → grep `ioredis|bullmq` absent.
3. workbench + worker typecheck+test.
4. Root ladder; `bun run e2e` — **bullmq suite green unchanged**.

Commits: `feat(core): publish the world contract and world-aware createQueueWorker`, `feat(worker): world-backed config (world XOR redis)`, `feat(workbench): allow zero-queue cores for non-bullmq worlds`.

---

## Task C2 — @openqueue/world-postgres + CLI + gates

### packages/world-postgres (NEW; template packages/client)

**package.json**: `@openqueue/world-postgres` v0.1.4, Node ≥18, single `.` export; deps `@openqueue/core: workspace:*`, `drizzle-orm ^0.45.1`, `postgres ^3.4.5`; devDeps drizzle-kit ^0.31.10, tsup, ts, vitest, @types/node. Scripts incl. `test:transport: "vitest run"` (joins root e2e chain) + `migrations:check`.

**src/schema.ts** — `queueSchema = defineQueueSchema({ schema: 'openqueue' })` (from `@openqueue/core/drizzle`) + the jobs table (pgSchema('openqueue')). Target DDL for `0001_init` (alongside the eight defineQueueSchema tables):

```sql
CREATE SCHEMA IF NOT EXISTS "openqueue";
CREATE TABLE "openqueue"."jobs" (
  "namespace" text NOT NULL, "queue" text NOT NULL, "id" text NOT NULL,
  "name" text NOT NULL, "data" jsonb,
  "priority" integer DEFAULT 0 NOT NULL,
  "attempts" integer DEFAULT 1 NOT NULL, "attempts_made" integer DEFAULT 0 NOT NULL,
  "backoff" jsonb,
  "state" text DEFAULT 'waiting' NOT NULL,          -- 'waiting' | 'active'
  "run_at" timestamptz DEFAULT now() NOT NULL,
  "claimed_until" timestamptz, "stalled_count" integer DEFAULT 0 NOT NULL,
  "seq" bigint GENERATED ALWAYS AS IDENTITY,
  "processed_on" timestamptz, "created_at" timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT "jobs_pk" PRIMARY KEY ("namespace","queue","id")
);
CREATE INDEX "openqueue_jobs_claim_idx" ON "openqueue"."jobs" ("namespace","queue","state","run_at","priority","seq");
```

`namespace` column keeps N workers on one DB from stealing jobs. Store tables stay namespace-blind (pre-existing postgresAdapter semantics) — document "one namespace per database" v1 topology.

**src/transport.ts** — `createPostgresTransport({ sql, namespace, poll?: { intervalMs=500, batch=10 }, stall?: { visibilityMs=30000, heartbeatMs=10000 } })`:
- id 'postgres'; capabilities `{ delay: true, priority: true, flows: false, deduplication: true, remove: true }`.
- enqueue: `INSERT ... ON CONFLICT DO NOTHING`, `run_at = now()+delay`; returns `{ jobId: spec.id }` either way. retention/ttl ignored (rows are ephemeral delivery state, deleted on terminal settlement; history lives in `runs`).
- enqueueFlow: typed throw. getJob: select by pk → handle; remove: `DELETE WHERE NOT (state='active' AND claimed_until > now())`; 0 rows + exists → "active" throw. listDelayed: waiting + run_at > now().
- consume poll loop: (1) stall pass — recover `active AND claimed_until < now()` via FOR UPDATE SKIP LOCKED; `stalled_count < (maxStalledCount ?? 1)` → waiting + counter+1 (attempts_made unchanged — BullMQ parity); else DELETE → onFailed(stallError, {final:true}). (2) claim — `UPDATE SET state='active', claimed_until=now()+vis, processed_on=COALESCE(processed_on,now()) WHERE pk IN (SELECT ... waiting AND run_at<=now() ORDER BY priority ASC, seq ASC LIMIT least(batch, concurrency−active) FOR UPDATE SKIP LOCKED) RETURNING *`. (3) non-empty → immediate re-poll; empty → sleep intervalMs. Heartbeat timer extends claimed_until per consumer. Settlement (local parity): success → DELETE + attemptsMade+1 in-memory + onCompleted; failure → `final = isFinal(err)`; retry → `UPDATE waiting, run_at=now()+retryDelay(backoff, attemptsMade+1), attempts_made+1, claimed_until=NULL`; terminal → DELETE; then onFailed. Callback exceptions → onError. Consumer close: stop loop+heartbeat, await in-flight. transport.close: close consumers, does NOT end sql (world owns).

**src/migrations.ts** — GENERATED, committed: `migrations: readonly WorldMigrationStep[]` (`{ id: '0001_init', checksum: '<sha256>', sql }`).

**src/migrate.ts** — `MIGRATION_LOCK_KEY = 0x6f710001`; `runMigrations(sql, steps, mode)` + `migrationStatus(sql, steps)` (no lock, read-only). Flow: reserved session → `pg_advisory_lock` → `CREATE SCHEMA IF NOT EXISTS` → `__openqueue_migrations(id pk, checksum, applied_at)` → per step: applied-with-different-checksum → HARD FAIL (both modes, names the step); pending+manual → fail with `Run \`openqueue migrations print\`... or set migrations: 'auto'`; pending+auto → transaction: `sql.unsafe(step.sql)` + bookkeeping insert.

**src/world.ts** — `worldPostgres({ url?, db?, migrations?: 'auto'|'manual', poll? }): WorldFactory`. Exactly one of url/db (runtime check). `db` is a postgres.js `Sql` (transport needs raw SQL/advisory locks/transactions); store = `postgresAdapter({ db: drizzle(sql), schema: queueSchema })` (imports only core/drizzle + core/world — bundle stays bullmq/ioredis-free). World: specVersion, transport, store, `migrations: { steps, status }`, `start: runMigrations(sql, steps, mode)`, `close: transport.close() then sql.end() if owned`. postgres.js is lazy → `migrations print` works without a DB.

**src/index.ts** — `export { worldPostgres, type WorldPostgresOptions }` only.

**drizzle.config.ts + drizzle/** — maintainer artifacts, committed, excluded from npm (`files: ["dist"]`): schema ./src/schema.ts, out `MIGRATIONS_OUT ?? './drizzle'`, schemaFilter ['openqueue'].

**scripts/generate-migrations.ts** — normal: drizzle-kit generate → per journal-ordered .sql: strip statement-breakpoints, rewrite `CREATE SCHEMA "openqueue";` → `IF NOT EXISTS` (runner pre-creates for bookkeeping), sha256 (node:crypto, generator-time), emit src/migrations.ts. `--check` (CI parity): scratch-copy drizzle/, regenerate → new file = drift = exit 1; regenerate migrations.ts in-memory, diff committed = exit 1.

**Tests** (all `describe.skipIf(!DATABASE_URL)`, scratch schema/namespace per run):
- `postgres-conformance.test.ts` — source-relative `describeTransportConformance`; `poll: { intervalMs: 100 }`; flows skips; beforeAll drops+recreates `openqueue` schema then applies migrations.
- `stall.test.ts` — short visibility (300ms, heartbeat off): killed consumer's job recovered by second consumer; maxStalledCount exceeded → onFailed({final:true}); heartbeat on (100ms) → long job not stolen.
- `migrate.test.ts` — fresh apply + idempotent rerun; 5 concurrent runMigrations race (advisory lock) → applied once; checksum tamper → hard fail; manual-on-pending → actionable error, after auto → passes; status states.
- `world.test.ts` — validateWorld passes; url/db XOR; close ends owned client only; injected db NOT ended.

### packages/cli
**MOD src/index.ts** — `migrations` command (`print` | `status`), in help(). loadCliConfig → require config.world (else actionable error) → `world = await config.world({ namespace: resolveNamespace(...) })` → require world.migrations → print: `-- <id>` + sql to stdout (no DB); status: rows `applied|pending|MISMATCH <id> [appliedAt]`, exit 1 on any mismatch; finally world.close(). (User config imports world-postgres itself; `openqueue build` externals already cover `@openqueue/*`.)

### e2e — the design-validating gate
- **env.ts**: `WORLD = process.env.E2E_WORLD === 'postgres' ? 'postgres' : 'bullmq'`; `PG_SCHEMA = WORLD === 'postgres' ? 'openqueue' : 'openqueue_e2e'`.
- **queue-schema.ts**: unchanged code (schema follows PG_SCHEMA → api.test.ts's Postgres-proof works in both modes untouched).
- **reset-db.ts**: pg mode → `DROP SCHEMA IF EXISTS "openqueue" CASCADE` and STOP (no DDL — every worker boot exercises the migration runner). bullmq unchanged.
- **preflight.ts**: pg mode → skip Redis ping + schema-exists check (worker self-migrates); keep pg reachability.
- **harness.ts**: config branch — pg: `{ world: worldPostgres({ url: DATABASE_URL }) }`; bullmq: unchanged. Add dep `@openqueue/world-postgres: workspace:*`.
- **NEW `src/__tests__/workbench-degradation.test.ts`** — skipIf not pg mode: boot with workbench enabled; /workbench/api/queues → []; /overview 200; /runs empty; dynamic schedule CRUD works; POST /workbench/api/test → run completes via client poll (live matrix proof).
- **Root package.json**: `"e2e:pg": "docker compose up postgres --wait && E2E_WORLD=postgres REDIS_URL=redis://127.0.0.1:9 turbo run test:transport e2e"` (poisoned REDIS_URL = enforced no-Redis proof).
- **turbo.json**: e2e.env += E2E_WORLD; test:transport.env += DATABASE_URL.

### Release + docs
- release-please-config.json: `packages/world-postgres { component: "world-postgres" }` + linked-versions; manifest `"packages/world-postgres": "0.1.4"`.
- README + CLAUDE.md row. MUST document: coexistence (postgresAdapter = bring-your-own-Drizzle escape hatch, user-owned schema/migrations; worldPostgres = fixed `openqueue` schema, self-migrating; can share a DB — disjoint schemas); switching = drain BullMQ first (in-flight jobs don't transfer), optional history migration = per-table `INSERT INTO "openqueue".<t> SELECT * FROM <old>.<t>` (snippet); one namespace per DB v1; migrations manual + CLI; poll latency; jobs-row lifecycle (delivery state only, history in runs).

### C2 verification
1. world-postgres: build+typecheck; DATABASE_URL → test (conformance skips exactly flows; stall + migrate green); migrations:check clean.
2. Bundle-graph: `bun build dist/index.js --bundle` → `ioredis|bullmq` absent (drizzle/postgres allowed).
3. `bun run e2e` — bullmq green UNCHANGED.
4. `bun run e2e:pg` — full suite green, poisoned REDIS_URL, dropped schema at start (runner exercised on first boot).
5. Root ladder.

Commits: `feat(world-postgres): SKIP LOCKED transport, self-migrating postgres world`, `feat(cli): openqueue migrations print|status`, `test(e2e): run the suite against world-postgres with no Redis`, `chore(release): add world-postgres to the release train`.

## Risks
- **Freeze**: `@openqueue/core/world` types, three factories + option shapes, QueueConfig.world, `openqueue` schema name, jobs layout, `__openqueue_migrations`, advisory-lock key, additive-only DDL. C1 index.d.ts diff = freeze artifact.
- **CreateQueueWorkerOptions interface→union** breaks `extends` downstream (0.1.x; release note). QueueConfig.redis now optional (note).
- **Multi-namespace one-DB**: jobs namespaced; store tables not (catalog publish last-writer-wins) — documented v1 limitation.
- **Runs page empty on pg worlds** (reads BullMQ, not core store) — docs must say run history = control API/client; workbench runs-from-store is future work.
- **Polling**: ≤500ms idle pickup; NOTIFY deferred deliberately.
- **Stall semantics** tested via internal `stall` hook (off public signature).
- **drizzle-kit drift** trips migrations:check spuriously on upgrades — regenerate-and-review; keep pinned.
- **WorkbenchCore({ queues: [] })** no longer throws (explicit empty intentional) — changelog.
- **Stage D seam**: clientFromWorld doesn't run start() — control-plane blueprint decides migration posture.
- **CI cost**: e2e:pg ~doubles e2e wall time.
