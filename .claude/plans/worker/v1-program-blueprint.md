# OpenQueue 1.0 Program Blueprint

> Architect blueprint. Four workstreams (WS1 file-level = next backend task; WS2–4 get short blueprints). Full text in the session record; this file is the executable contract.

## (a) What 1.0 means

Semver-guarded surfaces: `@openqueue/sdk`/core index + subpaths (`./auth ./control ./drizzle ./types ./world`); `@openqueue/client` (`.` + `./wire`) + the `/openqueue/v1` wire contract; the world contract at `WORLD_SPEC_VERSION = 1`; `OpenQueueConfig`; CLI commands; workbench package exports (dashboard internals explicitly NOT frozen). Support: Node >=20.11.1 or Bun >=1.2 for Node-capable packages (worker/cli Bun-only); lockstep releases continue; "20.11.1 is the floor (h3 v2 minimum); 22+ recommended". Post-1.0: `feat!` = 2.0.

## (b) Scope

IN: WS1 world-bullmq extraction (anchor); WS2 surface-freeze sweep; WS3 Node floor + jose v6; toNodeHandler docs (non-gating); WS4 release mechanics + migration guide.
OUT: NDJSON streaming → 1.1 (additive); withOpenqueue → 1.x; dev-parity store → 1.x; workbench runs-from-store → 1.1 fast-follow (docs state the gap); `migrations apply` → later; multi-namespace-per-db → later; h3 unpin → 1.0.x when a real stable ships (registry's "2.0.0" is the deprecated 2016 artifact); intermediate 0.2.0 → rejected (would mint a surface 1.0 deletes weeks later).

## (c) WS1 — world-bullmq extraction (file-level; behavior FREEZE — a move, not a redesign)

**Design**: new `@openqueue/world-bullmq` on the world-postgres template; core sheds bullmq/ioredis entirely. `redis: { url }` sugar survives ONLY in worker config, resolved by @openqueue/worker (gains the world-bullmq dep). sdk does NOT re-export world-bullmq (light installs are the point; worker/cli carry the default path). Workbench keeps its own bullmq/ioredis deps + QueueManager (dashboard-shaped, not transport-shaped). Rejected: sdk subpath re-export; QueueManager move.

**New `packages/world-bullmq/`** (template: world-postgres): deps core workspace + `bullmq ^5.71.1` + `ioredis ^5.10.1`; engines >=20.11.1; `test:transport` REDIS_URL-gated.
- `src/index.ts`: `worldBullmq`/`WorldBullmqOptions` + `createBullmqTransport`/`isBullmqTransport`/`BullmqTransport`/`BullmqConsumer`/`CreateBullmqTransportOptions`.
- `src/world.ts` ← core/world-bullmq.ts, options reshaped: url XOR clients; **`prefix?: string`** (absorbs bullPrefix, default 'bull'); `storage?: QueueStorage` becomes the sole catalog fallback (**`catalogFallbacks` dies** — only consumer was runtime's normalizeStores, which dies too).
- `src/transport.ts` ← core/transport/bullmq.ts verbatim + `defaultJobOptions` + prefix computation from queue.ts/namespace.ts.
- `src/state.ts` ← core/state.ts (redis write-through stores) + `redisKey`; imports filter helpers from `@openqueue/core/world` (newly re-exported there).
- `src/catalog.ts` ← redis catalog IO (catalogKey/writeQueueCatalog/readQueueCatalog/parseCatalogEntry) — the Redis format becomes package-private.
- `src/__tests__/` ← moved from core: bullmq-conformance, world-public, world-catalog, client-close (world-form), worker-drain, schedules-stale-tick, state-meta, RedisMock parts of catalog.test. Conformance imported SOURCE-RELATIVE (`../../../core/src/transport/conformance`) — **no `./transport-conformance` subpath at 1.0** (would freeze a vitest-coupled harness for zero external consumers; additive later).

**Core deletions**: `connection.ts`, `state.ts`, `world-bullmq.ts`, `transport/bullmq.ts`, `schedules-bullmq.ts`; `createWorker`/`CreateWorkerOptions` from worker.ts (keep createWorkerConsumers, QueueConcurrency); `configureEnqueue` from enqueue.ts (keep enqueue/enqueueFlow; configureEnqueueTransport stays internal); `createQueue`/`defaultJobOptions` from queue.ts; redis IO from catalog.ts.

**Core contract sweep** (while free):
- `namespace.ts`: `NamespaceOptions { namespace?: string }`, `ResolvedNamespace { namespace: string }` — bullPrefix/DEFAULT_BULL_PREFIX/redisKey move out.
- `world.ts`: **`WorldContext { namespace: string }`** (flattened — kills ctx.namespace.namespace); `./world` subpath re-exports `filterRuns`/`filterSchedules`/`runFromSnapshot` (store-author helpers). WORLD_SPEC_VERSION stays 1.
- `runtime.ts`: world-only signatures — `QueueClientOptions { world: WorldFactory; drains? } & NamespaceOptions`; `CreateQueueWorkerOptions` back to a single interface (world required); `QueueWorkerRuntime.transport: QueueTransport` + `consumers: readonly TransportConsumer[]` REPLACE `queues`/`workers`. Delete resolveClientRedis/resolveWorkerConnection/normalizeStores/isBullmqTransport branch.
- `index.ts` prune (freeze artifact = exact export diff, review gate): createConnection, closeConnection, QueueConnection, createQueue, defaultJobOptions, configureEnqueue, createQueueSchedules, createWorker, CreateWorkerOptions, bullPrefix, DEFAULT_BULL_PREFIX, redisKey, publishQueueCatalog, readQueueCatalog, queueCatalogKey, queueCatalogPublishedAtKey, worldBullmq, WorldBullmqOptions.
- `package.json`: remove bullmq+ioredis; description/keywords sweep (also sdk).
- `config.ts`: `redis?` STAYS (type-only sugar; docstring "resolved by @openqueue/worker via @openqueue/world-bullmq"); defineConfig stays in core.

**Worker**: +world-bullmq dep; validateConfig resolves redis form → `worldBullmq({ url, prefix: bullPrefix, storage })`; always calls createQueueWorker({ world }); queue names from `runtime.tasks`; metrics/WorkbenchCore queues via `isBullmqTransport(runtime.transport) ? names.map(n => transport.queue(n)) : []`; worker-count log via `runtime.consumers.length`.

**Untouched**: workbench (verified — imports none of the moved symbols; keeps own bullmq ^5.71.1 IDENTICAL to world-bullmq's — Queue instances cross the boundary), cli, client, sdk (auto-shrinks), e2e (harness redis sugar flows through worker → becomes the world-bullmq integration proof unchanged).

**Repo**: NEW `scripts/check-core-clean.ts` (bundle-graph scan of every core dist entry for ioredis/bullmq — the load-bearing gate; hoisting makes phantom imports typecheck) + CI step; core test no longer needs REDIS_URL, world-bullmq does; release-please config+manifest add world-bullmq (bootstrap "0.1.4" so linked-versions lifts to 1.0.0); verify scripts/publish.ts includes it.

**WS1 gates**: build/typecheck + check:core-clean + existing 3 gates; core suite green with NO REDIS_URL; world-bullmq suite green with Redis (conformance 13/13); e2e ×3 zero assertion changes; core index.d.ts freeze-artifact diff reviewed line-by-line.

## (d) WS2–WS4 (contract level)

**WS2 — surface-freeze sweep**: `EnqueueResult → { runId, jobId }` (drop id/transportJobId dupes; QueueRun.transportJobId stays); **remove `ttl`** everywhere (verified silent no-op on all transports; typed-degradation violation; keep drizzle column — don't churn 0001_init checksum); flatten `storage: { adapter } → storage: QueueStorage`; control-app `/**` catch-all → 404 wire envelope; `UnsupportedCapabilityError → 501 unsupported_capability` in the v1 serializer (+ both codes in WireErrorCode; widen wire cancel `reason` to z.string(); CancelRunResult union unchanged); toRunListOptions 400s; delete dead `WorkerConfig`/`TelemetryConfig`/`defineWorkerConfig` block + verify-delete `queue()`/`QueueDefinition*`; collapse QueueConfig/OpenQueueConfig alias. Gates: e2e ×3, wire round-trips, freeze-artifact diff #2.

**WS3 — Node floor + jose v6**: engines >=20.11.1 on core/sdk/client/world-postgres/world-bullmq; jose ^6 (6.2.3 verified: no engines constraint; our API surface unchanged); CLAUDE.md/READMEs; CI setup-node import-check on 20.11 + 22. Gates: typecheck, auth suites, Node import checks.

**WS4 — release + docs**: migration guide as site docs "Upgrading to 1.0"; docs refresh (quickstart/configuration/persistence/workbench predate the umbrella); release-notes item for the Runs-page gap; dry-run inspection of the release PR (1.0.0 across all 8 components).

## (e) Migration guide outline
Requirements (Node 20.11+/Bun 1.2+; lockstep 1.0.0) → "the 90% path is unchanged" (worker.config.ts redis sugar + openqueue dev|start) → new packages → removed-core-APIs table (configureEnqueue → createClient({host}) recommended / createQueueClient({world}) → etc.) → type changes → workbench (./h3, Node floor, deps, basic-auth → walk, Runs-page note) → security behavior changes → new surfaces → semver statement.

## (f) Sequencing — STRAIGHT TO 1.0, no 0.2.0
1. Push + merge `feat/worker-umbrella` → main **preserving the 13 conventional commits** (merge or rebase-merge; a squash flattens the per-package feat! markers release-please needs).
2. release-please auto-proposes 1.0.0 (feat! + bump-minor-pre-major unset → 0.1.4 → 1.0.0, linked-versions lifts the group). `release-as: "1.0.0"` in config is the documented fallback. **Hold the release PR open.**
3. WS1 → WS2 → WS3 as separate PRs (blueprint → backend → QA each), each updating the release PR.
4. WS4, audit release PR body, merge = publish 1.0.0 (verify publish.ts includes world-bullmq + workspace:* rewrite).
5. h3 stays pinned; unpin = 1.0.x follow-up.

## (g) Risks
Frozen surface permanence (freeze-artifact diffs are named review gates in WS1+WS2); phantom-dependency hazard (check:core-clean is the real protection); release-please linked-versions + new-component quirks (inspect the release PR; release-as fallback); publish atomicity (worker@1.0.0 ↔ world-bullmq@1.0.0 same batch); bullmq range coupling world-bullmq ↔ workbench (keep identical); behavior drift during the move (zero-assertion-change e2e ×3 + moved tests); Node 20 EOL floor is policy-documented; known gaps shipped knowingly (Runs page, no streaming, h3 RC) stated in docs.
