# Blueprint — Phase 3 Stage D: Split control plane

> Architect blueprint, file-level, single backend task. Gates: pre-existing tests green unchanged (extraction-parity), index/types/drizzle/world d.ts byte-stable (reorder-only fallback documented in freeze artifact), both existing e2e modes green unchanged, new bundle gates green, split-plane e2e green.

## Design summary

Core gains an import-clean composition module: `createControlRuntime(worldFactory, opts)` → `{ trigger, runs, schedules, catalog, close }` over a world with **no consumers, no module-global state, no DDL**. Enabler: extract `enqueue.ts`'s module-globals into instance-scoped `createEnqueuer({ transport, drain })` (new internal module); the module-global path (`configureEnqueue`/`enqueue`/`enqueueFlow`, exact signatures + error strings) delegates to one default instance; runtimes get isolated instances (fixes Stage B's one-runtime-per-process drain-accumulation as a side effect). Two new core subpaths (`./auth`, `./control`) + a lean workbench `./control` entry give the edge deployment a bundle graph free of ioredis/bullmq, proven by extending the `check-world-clean.ts` gate pattern. Rejected alternative: deriving from `createQueueClientFromWorld` — dead on arrival, `runtime.ts` imports ioredis at module scope; composition lives in a clean module that runtime.ts then CONSUMES (dependency inverted, wiring deduplicated).

## The five decisions

1. **Migration posture: NEVER migrate — validate-only.** `createControlRuntime` does not call `world.start()`. If `world.migrations` exists: `status()` → throw actionable on any pending/checksum_mismatch: *"N pending migration(s) (`ids`). The control plane never applies DDL — boot the execution worker with `migrations: 'auto'`, or apply them with `openqueue migrations print`."* Worlds without migrations pass through. Rationale: the shared-world-factory footgun (same `worldPostgres({ migrations: 'auto' })` imported into both configs would leak DDL to Workers cold starts). Codifies the seam: **producer-side compositions never start worlds; only `createQueueWorkerFromWorld` calls `world.start?.()`**. `createQueueClientFromWorld` stays sync/unchanged. Document in control.ts docstring + site docs; do NOT edit world.ts docstrings (keeps world.d.ts byte-stable).

2. **Enqueuer: instance-scoped, subpath-only, no namespace param.** `createEnqueuer({ transport, drain })` — namespace dropped from the phase sketch (nothing reads it; transport owns namespacing). enqueue.ts keeps every public export byte-identical incl. the exact `'@openqueue/sdk: enqueue() called before configureEnqueue({ redis, drains? }). Call it at process boot.'` error. `configureEnqueueTransport` keeps accumulate-drains semantics (recreates default instance) + its `bindQueueRuntime({ trigger })`. From-world factories create own Enqueuer AND still call `configureEnqueueTransport` (bare `enqueue()`/`task.trigger()` identical in single-runtime processes). Observable delta: multi-runtime drain isolation (the fix) — release-note it. **d.ts: subpath-only.** `createControlRuntime` NOT on index; `createEnqueuer` fully internal. index/types/drizzle/world d.ts byte-stable; freeze artifact = new auth.d.ts + control.d.ts (+ any proven-reorder-only index diff).

3. **HTTP serving: e2e harness extension + docs recipe.** NEW `e2e/src/control-plane.ts` (~40-line Bun.serve+Hono boot of buildControlApp over createControlRuntime(worldPostgres)); site docs carry the two-plane recipe (Node/Bun + Workers-flavored `db`-injection variant). No examples/control-plane package.

4. **Workers proof: prove the graph, document the runtime.** NEW `scripts/check-control-clean.ts` (same Node-stdlib probe pattern as check-world-clean.ts — ADD, don't modify): probes `core/dist/auth.js`, `core/dist/control.js`, `workbench/dist/control.js`; `--target=node` pass greps `ioredis|bullmq` (drizzle allowed); `--target=browser` pass must BUILD and surviving `node:*` specifiers must equal exactly `{ node:crypto }` (enqueuer's randomUUID — Workers nodejs_compat-safe; do NOT swap to global crypto.randomUUID, flag-gated on Node 18). Workerd execution: documented-supported (worldPostgres({ db }) + Neon/Hyperdrive), NOT CI-proven — say so honestly. Edge bundle riders all pure-JS/Workers-safe: @opentelemetry/api, zod, jose, cron-parser.

5. **spans/alerts: absent from control-plane deployments — unchanged.** Not in the wire contract, not on workbench ControlRuntime; createControlRuntime return omits them. Dashboard/execution-plane feature. State in docs.

## Affected packages

core (enqueuer extraction + control composition + 2 subpaths), workbench (./control entry; api/v1/auth.ts imports from core/auth), scripts/e2e/CI/docs. **Untouched**: world-postgres, worker, cli, client, sdk (no ./control re-export in Stage D; additive later).

## File-level plan (single backend task, in order)

### packages/core

1. **NEW `src/enqueuer.ts`** (internal, not a tsup entry): `EnqueuerOptions { transport; drain? (already-composed; default composeDrains()) }`; `Enqueuer { enqueue<I,O>(def, input, opts?): Promise<EnqueueResult>; enqueueFlow(parent): Promise<EnqueueResult> }`; `createEnqueuer(options)`. Move VERBATIM from enqueue.ts: buildJobData, QueueJobData, buildJobSpec, enqueueStatus, buildEnqueueSnapshot, stringMeta, both hook emitters (drain-parameterized), BuiltFlowNode, withParentRunId, assertFlowJobId, buildFlowNode, toTransportFlowNode, flow hook emitters, enqueue/enqueueFlow bodies. PRESERVE EXACTLY: capability check → enqueue hook → transport.enqueue ordering (conformance-pinned) + failure-hook-then-rethrow. Kill the four `def as unknown as TaskDefinition` casts by narrowing hook/snapshot param to `Pick<TaskDefinition, 'name'|'queue'|'attempts'|'tags'>` — net cast delta negative. Import-clean (node:crypto, compose, errors, otel-hooks, transport/types, types).

2. **MOD `src/enqueue.ts`** → public facade (~60 lines): `defaultEnqueuer: Enqueuer | null` + accumulating sharedDrain; configureEnqueueTransport recreates default instance + keeps bindQueueRuntime({ trigger }); configureEnqueue byte-identical; enqueue/enqueueFlow delegate via assertEnqueuer() throwing the exact current string. Keeps transport/bullmq import (index-graph-only file).

3. **MOD `src/schedules.ts`** — delete createQueueSchedules + bullmq/ioredis imports (now import-clean; task.ts is type-import-only, verified). **NEW `src/schedules-bullmq.ts`** — createQueueSchedules moved verbatim.

4. **NEW `src/control-compose.ts`** (internal): `WorldRuntimeParts { drain; enqueuer; resolveTask(id); trigger(id|def, input, opts?); schedules: QueueScheduleController (kills runtime.ts's two `as QueueScheduleController` casts); runs: QueueRunsApi; catalog: Pick<QueueCatalogStore,'read'|'resolve'>; close() (schedules.close → world.close) }`; `composeWorldRuntime(world, { drains? } & NamespaceOptions)`. resolveTaskFromStore/triggerFromStore move here (trigger calls parts.enqueuer.enqueue incl. catalogEntryDefinition path); drain = composeDrains(world.store, ...drains); schedules via createQueueSchedulesWithTransport; runs via createRunsApi + createRunCancel({ store, transport, getQueue: name => ({ getJob: id => transport.getJob(name, id) }), drain }). Import-clean.

5. **NEW `src/control.ts`** (tsup entry → `@openqueue/core/control`): `ControlRuntimeOptions extends NamespaceOptions { drains? }`; `ControlRuntime { trigger; runs; schedules: QueueSchedulesApi; catalog: Pick<...>; close() }`; `createControlRuntime(world: WorldFactory, options = {}): Promise<ControlRuntime>`. Body: resolveNamespace → validateWorld(await world({ namespace })) → migration gate (decision 1) → composeWorldRuntime → narrow. NO world.start(), NO bindQueueRuntime, NO configureEnqueueTransport — zero module-global mutation (the Workers-friendly property). Async return = deliberate deviation from the phase sketch (migration probe forces it). Docstring carries the lifecycle rule.

6. **MOD `src/runtime.ts`** — both from-world factories delegate their middle to composeWorldRuntime, then: still call configureEnqueueTransport({ transport, drain: parts.drain }); client adds spans/alerts from store, close = parts.close() then onClose; worker keeps await world.start?.(), catalog publish, syncDeclarativeSchedules(tasks, parts.schedules) (cast gone), scheduleTickJob, consumers, existing close order. closeSchedules helper deleted.

7. **MOD `src/index.ts`** — ONLY `export { createQueueSchedules } from './schedules-bullmq';` (alphabetical slot). Zero new index exports.

8. **MOD package.json + tsup.config.ts** — exports/entries gain `./auth` → src/auth.ts (no source change; already import-clean) and `./control` → src/control.ts. CONFIRM dist keeps shared ESM chunks so UnauthenticatedError/ForbiddenError have ONE class identity across index/auth entries (instanceof inside authenticate with strategies importing from index) — check dist/chunk-*.js exists.

9. **NEW `src/__tests__/control.test.ts`** (worldLocal, no services): trigger by catalog id → run `queued` in store with no consumer; runs list/retrieve/cancel of queued; schedules.create → tick in transport.listDelayed; **two control runtimes in one module with distinct drains → no cross-firing** (the test Stage B couldn't write); stub world with migrations.status() pending/checksum_mismatch → actionable throws; no-migrations world constructs. Existing enqueue/flow/schedules/runtime tests pass UNCHANGED (extraction-parity gate).

### packages/workbench

10. **MOD `src/api/v1/auth.ts`** — runtime imports (apiKey, authenticate + types) from `@openqueue/core/auth`. Type-only core imports elsewhere stay.
11. **NEW `src/control.ts`** (tsup entry → `@openqueue/workbench/control`): `export { buildControlApp } from './api/v1/app'; export type { ControlApiOptions, ControlRuntime } from './api/v1/routes'; export type { ControlAuth, ControlAuthConfig, ControlAuthDecision } from './api/v1/auth';` — nothing else. `./hono` keeps re-exporting buildControlApp (worker unchanged). If util.ts drags anything heavy into the graph, the gate fails → inline errorMessage.
12. **MOD package.json + tsup.config.ts** — ./control export + entry.

Name collision note: workbench ControlRuntime (no close) vs core ControlRuntime (adds close) intentionally share a name across import paths; core's is structurally assignable. Document in both docstrings; don't rename.

### Repo-level

13. **NEW `scripts/check-control-clean.ts`** — per decision 4 (Node stdlib, shells to `bun build` CLI like check-world-clean.ts).
14. **e2e** — NEW `src/control-plane.ts` (Bun.serve + Hono `.route('/openqueue/v1', buildControlApp({ runtime, auth: { token }, info: { namespace } }))` over createControlRuntime(worldPostgres({ url, migrations: 'manual' }), { namespace }); start/stop). NEW `src/__tests__/split-plane.test.ts`: Postgres from compose, poisoned REDIS_URL; port B = existing worldPostgres worker harness (auto migrations, consumers, echo); port A = control plane, no consumers; same namespace + shared token; client points ONLY at A. Cases: catalog via A lists B's tasks; trigger via A → executes on B (poll completed via A, assert output); delayed trigger + cancel via A → canceled; schedules CRUD + runNow via A → executes on B → deactivate; **first-deploy ordering**: drop schema → boot A → actionable never-migrate error; boot B (migrates) → boot A → healthy. Root script `e2e:split` mirroring e2e:pg conventions (--concurrency=1, poisoned Redis; keep core's bullmq conformance OUT of the filter per the C2 lesson). Existing e2e/e2e:pg untouched.
15. **CI + docs** — CI: check-control-clean after build; `e2e-split` job cloned from e2e-pg (postgres-only service). Site docs: "Two-plane deployment" recipe (worker owns DDL; control never migrates; Workers variant with db injection + nodejs_compat; module-scope runtime caching; spans/alerts on execution plane; CI-proven vs manually-verified honesty).

## Sequencing & verification

1. Snapshot pre-Stage-D dist/*.d.ts baseline. Core 1–9 → core typecheck/test (pre-existing green UNCHANGED) → build → byte-diff index/types/drizzle/world.d.ts (expect empty; reorder-only fallback documented) → record auth.d.ts/control.d.ts as the +exports freeze artifact.
2. check-control-clean green (2 core probes); check-world-clean still green.
3. Workbench 10–12 → typecheck/test/build → workbench probe green; v1 suite green unchanged.
4. Root ladder; `bun run e2e` (bullmq) green UNCHANGED; e2e:pg green UNCHANGED.
5. Items 13–14 → e2e:split green incl. dropped-schema ordering case.
6. CI + docs.

Commits: `feat(core): control-plane runtime, auth/control subpaths, instance-scoped enqueuer`, `feat(workbench): lean ./control entry`, `test(e2e): split control/execution plane suite`, ci/docs chores. No new packages.

## Risks

- New frozen surfaces: core ./auth (full auth.ts surface), core ./control (3 symbols), workbench ./control. All additive; index untouched.
- Hottest-path refactor (enqueue): verbatim moves; ordering pinned by conformance + unchanged tests + two e2e suites; the one intended delta (multi-runtime drain isolation) gets its own test + release note.
- d.ts: createQueueSchedules re-export move may reorder index.d.ts — freeze artifact proves reorder-only if so. world.d.ts stays stable by not touching world.ts docs.
- Shared-factory `migrations:'auto'` surprise: control plane validates instead of applying even on auto — intended; error + docs must say so explicitly.
- Workers honesty: graph-clean + browser-target proven; workerd execution documented-supported only.
- Class identity across entries relies on tsup shared chunks — step 1 must confirm.
- Two ControlRuntime interfaces: structural compatibility is load-bearing; future workbench fields must be mirrored in core's.
