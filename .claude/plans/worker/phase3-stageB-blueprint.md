# Blueprint — Phase 3 Stage B: world-local

> Architect blueprint, file-level (single backend task). Gates: zero public surface (d.ts byte-stable), all pre-existing tests green unchanged, e2e green unchanged, conformance green on local WITHOUT services (ungated, default CI).

## Design summary

Add an in-memory `QueueTransport` (all five capabilities true) and in-memory `QueueStorage`, compose behind the internal `OpenQueueWorld` seam, recompose `runtime.ts` as build-world-then-wire. Public `createQueueClient`/`createQueueWorker` keep exact signatures and build a bullmq world internally; tests reach the world path via module-level (non-index) exports `createQueueClientFromWorld`/`createQueueWorkerFromWorld` — no option-type change, no casts, nothing new in `dist/index.d.ts`.

**Decision — cancel/remove capability gate: NOW (Stage B), inside `createRunCancel`**: after the not_found/already_finished/executing branches, before `getJob`, OUTSIDE the try/catch (so `UnsupportedCapabilityError` propagates instead of mapping to `not_cancelable`). `CancelRunDeps` gains `transport: Pick<QueueTransport, 'id' | 'capabilities'>`.

**Decision — fixture unification: absorb both.** Real memory store mirrors redis-state semantics exactly; both existing fixtures diverge in ways that are bugs (dedupe on `undefined === undefined`; dedupe-hit resetting `active: true`; shallow meta filter; no sort). `__tests__/support/memory-storage.ts` → re-export + `catalogEntry` helper; inline copy in `schedules.test.ts` deleted. If a test asserts fixture-specific divergence: fix the test, never the store.

## Affected: `@openqueue/core` only. No downstream changes; e2e untouched.

## File-level plan

### 1. NEW `src/store/filter.ts`
Move VERBATIM from `state.ts` (zero behavior change): `filterRuns`, `runSorter`, `runSortDate`, `filterSchedules`, `scheduleSorter`, `scheduleSortDate`, `containsMeta` (+ private `deepContains`, `isMetaRecord`), `compareDates`, `cursorOffset`, `runFromSnapshot`. `isFullScheduleList` stays in state.ts (redis-specific). MOD `state.ts` (delete moved, import from `./store/filter`); MOD `state-meta.test.ts` (import `containsMeta` from `../store/filter`).

### 2. NEW `src/store/memory.ts` — `memoryQueueStorage(): QueueStorage`
- Catalog: delegate to existing `memoryQueueCatalogStore()` from catalog.ts.
- `handle(event)`: `runs.set(run.id, runFromSnapshot(event.run))` — full-overwrite parity with redis `writeRun`. `name: 'memory-storage'`.
- `runs.list`: `filterRuns([...runs.values()], options)`.
- Schedules mirror `state.ts` redis semantics EXACTLY: create with live dedupe-key → patch in place (same field-merge as `updateRedisSchedule`, preserving `id`/`createdAt`/`active`); else insert `active: true`. Maintain `Map<dedupeKey, id>`. update/activate/deactivate/complete: patch semantics copied incl. the `externalId` undefined-vs-null ternary. list: `filterSchedules(...)`. delete: remove + dedupe mapping, return boolean.
- Alerts: Map-backed AlertStore (`crypto.randomUUID()` + timestamps per state.ts builders; name-sorted lists; `close` omitted). Spans: undefined.
- MOD `__tests__/support/memory-storage.ts`: delete inline impl; keep `catalogEntry`; re-export `memoryQueueStorage as memoryStorage`. MOD `schedules.test.ts`: delete inline copies (~150 lines), import from support.

### 3. NEW `src/transport/local.ts` — `createLocalTransport(): QueueTransport` (id 'local', all capabilities true)
Per queue: `jobs: Map<string, LocalJobRecord>` (dedupe map + getJob source; job leaves map only on final settle or remove) + `consumers[]`.

`LocalJobRecord`: `{ id, spec, queue, data (mutable — updateData persists across retries), state: 'delayed'|'waiting'|'waiting-children'|'active', seq (FIFO tiebreak), timestamp, attemptsMade, processedOn?, finishedOn?, returnvalue, progress, timer?, parent?, pendingChildren }`.

`ActiveTransportJob` built per attempt as object literal with **getters** over the record (data/attemptsMade/returnvalue/processedOn/finishedOn — structural, zero casts); `updateData`/`updateProgress` assign record fields; `log` no-op returning 0 (note for Stage C UX). `opts = { attempts: spec.attempts, delay: spec.delay }`.

**pump(queue)**: sync loop — while a consumer has `active < (concurrency ?? 1)` and a waiting job exists, pick min `(spec.priority ?? 0, seq)` (BullMQ parity: no priority = 0 = highest; lower first; FIFO within equal), mark active, run attempt. Re-pump on: enqueue, delay promotion, retry re-queue, settle, consumer registration, parent promotion.

**Attempt lifecycle** (pins conformance conventions):
1. `processedOn` on first activation; `options.process(job)`; on throw do NOT convert errors (no UnrecoverableError in local).
2. After settle: `attemptsMade += 1` (0-based inside process(), includes current in callbacks — getters make both views correct).
3. Success: returnvalue/finishedOn, delete from map, `await onCompleted(job)` (callback errors → onError), parent settlement.
4. Failure: `final = options.isFinal(err)` — EXACTLY "error is non-retryable", NOT "retries exhausted" (worker.ts computes willRetry separately). `willRetry = !final && attemptsMade < (spec.attempts ?? 1)`. Retrying → state delayed, `setTimeout(retryDelay)` → promote → pump; record STAYS in map. Not → finishedOn, delete, parent settlement. Both: `await onFailed(job, err, { final })` — EVERY attempt.
5. retryDelay from `spec.backoff`: undefined→0; number→n; fixed→delay; exponential→`Math.round(delay * 2 ** (attemptsMade - 1))` (post-increment).
6. Free slot, pump.

**enqueue**: `jobs.has(spec.id)` → return `{ jobId: spec.id }` untouched (dedupe parity given local drops finished jobs — pinned best-effort semantics). Else record; delay>0 → delayed + timer; else waiting + pump. retention/ttl/maxStalledCount accepted and IGNORED (document in module comment).

**getJob/listDelayed**: handle `{ name, data (getter), attemptsMade (getter), opts: { attempts }, remove }`. listDelayed = state==='delayed' only. `remove()`: active → throw `` `@openqueue/sdk: job "${id}" is active and cannot be removed` ``; else clear timer, delete, and live parent → decrement pendingChildren (promote at 0).

**Flows**: recursive record creation; parents `waiting-children` + `pendingChildren = children.length`; leaves normal admission. Child settlement (guard: parent still in map AND still waiting-children):

| Child outcome | flag | behavior (BullMQ reference) |
|---|---|---|
| completed | — | decrement; at 0 promote parent (apply parent spec.delay via timer if set) |
| final failure | none | NOTHING — parent stays waiting-children indefinitely (blocked-parent default) |
| final failure | ignoreDependencyOnFailure | decrement as if completed |
| final failure | failParentOnFailure | fail parent immediately: delete from map, NO onFailed callback (worker-event parity); recurse upward iff parent's own spec has the flag |
| final failure | continueParentOnFailure | promote parent immediately; remaining children keep processing, later settlements no-op. Not recursive |
| removed pre-delivery | — | decrement, promote at 0 |

All three flags implemented faithfully (one-branch rules each in the counting model).

**consume**: register `{ options, active: 0, closed, inflight: Set<Promise> }`, pump, return `{ close }`. close(): mark closed, deregister, `await Promise.allSettled(inflight)`; backlog remains. **transport.close()**: clear all timers, close consumers, clear maps; idempotent.

### 4. MOD `src/cancel.ts` + `cancel.test.ts`
`CancelRunDeps.transport: Pick<QueueTransport, 'id' | 'capabilities'>`; `assertCapability(deps.transport, 'remove')` after status branches, before getJob, OUTSIDE try/catch. Tests: add stub transport to six deps literals; +2 cases (queued run on remove:false → UnsupportedCapabilityError with capability==='remove', zero drain events; terminal run on remove:false → still already_finished). Not on index chain — d.ts unaffected.

### 5. NEW `src/world.ts` (NOT exported from index.ts)
`WORLD_SPEC_VERSION = 1`; `WorldContext { namespace: ResolvedNamespace }`; `OpenQueueWorld { specVersion, transport, store: QueueStorage (required), start?(), close() }`; `WorldFactory`; `validateWorld(world)` (exact specVersion with actionable message; shallow structural: transport methods + id/capabilities; store.{schedules,runs,alerts} + {handle,publish,resolve,read}).
- `worldLocal(): (ctx) => OpenQueueWorld` — local transport + memory storage; close = transport.close(); ctx unused.
- `worldBullmq({ producer, consumer?, storage?, catalogFallbacks? })` — transport = createBullmqTransport; store = createRedisQueueState(producer, storage, ns) extended with catalog ops + `spans: storage?.spans`:
  - `publish` = redis write + every fallback publish — via NEW module-level `writeQueueCatalog(redis, entries, namespace)` extracted in catalog.ts (public `publishQueueCatalog` keeps exact signature, delegates; also add `queueCatalogEntries(tasks, updatedAt?)` — neither in index.ts).
  - `resolve(id)` = redis hget → parse; miss OR redis error → fallbacks in order; total miss → undefined, but redis-threw-and-no-fallback-hit → rethrow (preserves runtime resolveTask catch-all).
  - `read()` = redis hgetall (errors PROPAGATE — today's asymmetry preserved) → non-empty wins; else first non-empty fallback; else [].
  - `close()` = transport.close() then store.alerts.close?.() (today's order).
- Factories typed sync `(ctx) => OpenQueueWorld` (createQueueClient is sync); `WorldFactory` stays broad for Stage C.

### 6. MOD `src/worker.ts` — generify
`createWorkerConsumers<C extends TransportConsumer>(jobs, transport: { consume(queue, options): C }, options?): C[]` — body unchanged; `createWorker` still infers `BullmqConsumer[]` and unwraps `.worker`. NEW in bullmq.ts: `isBullmqTransport(t): t is BullmqTransport` (`t.id === 'bullmq'` — id reserved; type predicate, not a cast).

### 7. MOD `src/runtime.ts` — build-world-then-wire
Module-level exports NOT in index.ts: `FromWorldOptions { drains?, onClose? } & NamespaceOptions`; `WorkerFromWorldOptions extends … { tasks, globalConcurrency?, queueConcurrency? }`; `createQueueClientFromWorld(world, options?)`; `createQueueWorkerFromWorld(world, options)`.

Wiring (both): `drain = composeDrains(world.store, ...(options.drains ?? []))`; `configureEnqueueTransport({ transport, drain })`; resolveTask = store.resolve → miss throws verbatim `` `Unknown task "${id}"; worker catalog has not been published` ``; schedules via createQueueSchedulesWithTransport over store; runs via createRunsApi + createRunCancel({ store: world.store.runs, transport: world.transport, getQueue: name => ({ getJob: id => world.transport.getJob(name, id) }), drain }); spans = store.spans; close = consumers → schedules → world.close() → options.onClose?.().

Worker-only: `await world.start?.()` first; catalog = queueCatalogEntries(tasks) via store.publish; attachSpanStore(store.spans) when set; consumers = createWorkerConsumers(tasks, world.transport, …); `workers`/`queues` populated ONLY under isBullmqTransport (bullmq: consumers.map(c => c.worker) + transport.queue(name) loop — e2e blockingConnection reach-in intact; local: [] + empty Map — frozen public types satisfied).

Public wrappers delegate: build `validateWorld(worldBullmq({ producer, consumer, storage: options.storage, catalogFallbacks: normalizeStores(options.catalog, options.storage) })({ namespace }))` then `createQueue…FromWorld(world, { drains: [options.storage, ...(options.drains ?? [])], onClose: client → redis quit / worker → ownsConnection ? closeConnection : undefined, …namespace, tasks, … })` — preserves composeDrains membership/order. Delete absorbed redis-catalog helpers + direct createRedisQueueState/publishQueueCatalog calls. `QueueClient.catalog.resolve` keeps throw-on-miss.

### 8. NEW tests
- `src/transport/__tests__/local-conformance.test.ts` — UNGATED: `describeTransportConformance({ name: 'local', create: () => createLocalTransport(), timing: { settleMs: 2000, delayMs: 250 } })`.
- `src/transport/__tests__/local.test.ts` — beyond conformance: blocked-parent default; each failure flag (incl. failParentOnFailure grandparent recursion gated on parent's own flag + no parent onFailed); child-remove unblocks parent; exponential backoff math (loose bounds); close() clears pending delayed timers. (Promoting into shared conformance = Stage C homework.)
- `src/__tests__/world-matrix.test.ts` — table `[['local', worldLocal()]]` (postgres joins Stage C), real timers, ONE runtime per file (module-global enqueue state — note in header; Stage D's createEnqueuer fixes):
  1. trigger by string id (proves memory-catalog resolve) → poll completed with output → runs.list contains.
  2. schedules.create → one tick in listDelayed(scheduleQueue) → runNow → poll scheduled run (scheduleId meta) → delete → listDelayed empty. (Tick FIRING not awaited — cron ≥1min + real timers; delay delivery pinned by conformance, fire() by mocked tests. close() clearing tick timer proves no hang.)
  3. cancel: trigger delay 5000 → status delayed → cancel → canceled + getJob undefined + retrieved canceled.
  4. flow: parent+child via enqueueFlow → child side-effect before parent → both completed.
  afterAll runtime.close() — vitest hanging-handle detection doubles as timer-cleanup gate.

## Sequencing (each step: core typecheck + test)
0. FIRST: build core and save `dist/{index,types,drizzle}.d.ts` baseline to scratchpad.
1. filter extraction — green; d.ts diff empty.
2. memory store + fixture absorption — schedules + stale-tick green under redis-parity semantics.
3. local transport + tests — `bun run test:transport` green with NO REDIS_URL (bullmq self-skips; local must NOT skip).
4+5. cancel gate + world/runtime recomposition in one motion (cancel dep change compiles only when runtime wires transport) — full core green; **d.ts byte-diff empty (load-bearing gate)**.
6. world-matrix — green, no hanging handles.
7. Root build/typecheck/test; then `bun run e2e` (compose ports 6380/5434 env) — green unchanged.

Commits: `feat(core): add in-memory local transport`, `feat(core): compose transports and stores behind an internal world seam` — explicit "no public API change" notes.

## Risks
- **Catalog parity is the sharp edge**: fallback order (redis → options.catalog[] → storage), publish fan-out, resolve-swallows-redis-errors vs read-propagates asymmetry, two distinct "Unknown task" messages verbatim. Detectors: e2e + workbench queue-manager tests.
- **d.ts byte-stability**: world.ts/store/*/local.ts/from-world funcs ride index.js bundle (JS chunks may change) but must not appear in any .d.ts. Verify by diff, not inspection.
- **Fixture absorption may flush latent assumptions** in schedules tests (real store sorts nextRun asc, preserves active on dedupe-hit, deep meta). Rule: redis semantics win; adjust assertions, never the store.
- **Module-global enqueue state** limits one live runtime per test module; deferred to Stage D createEnqueuer.
- **Local transport is behavior-pinned, not "fixed"**: final = non-retryable (not exhausted); finished jobs vanish (retention ignored); failed flow parents emit no worker callback (runs stay waiting_children in drain view) — all BullMQ parity, inherited by world-postgres in Stage C.
- **Cancel gate** commits UnsupportedCapabilityError-on-cancel ahead of Stage C freeze — intended; CancelRunResult unchanged.
