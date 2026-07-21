# Blueprint: remove `createQueueClient` — HTTP-only consumer dispatch

Decision (maintainer, 2026-07-20): the in-process consumer dispatch path is removed
entirely before 1.0 ships. Consumers only talk to a deployed worker over HTTP via
`@openqueue/client` / `@openqueue/sdk/client`. Server-side factories stay:
`createQueueWorker`, `createControlRuntime`, the world contract.

## Design summary

Delete the in-process producer client (`createQueueClient` + its private helper
`createQueueClientFromWorld`) and its option/shape types from core. Everything that
must survive already lives elsewhere: `bindQueueRuntime` takes the *internal*
`QueueRuntime` interface (`{ trigger, schedules? }` in `task.ts`), not `QueueClient`,
so the SDK HTTP binding is untouched; the producer-over-a-world composition survives
as `createControlRuntime` (`@openqueue/core/control`), which is `composeWorldRuntime`
returned near-verbatim — the exact same `parts.trigger/runs/schedules/catalog/close`
the client factory wrapped. Tests that used `createQueueClient` as "producer
composition over a world" port 1:1 to `createControlRuntime`; the HTTP-client
conformance test retargets from `Omit<QueueClient, 'alerts' | 'spans'>` to
`ControlRuntime`, which is member-for-member identical (verified: `catalog:
Pick<QueueCatalogStore,'read'|'resolve'>`, same `trigger` signature incl.
`O = unknown`, `QueueSchedulesApi`, `QueueRunsApi`, `close`). No new exports
anywhere; the surface only shrinks.

Alternative considered and rejected: keep `QueueClient` as a type-only "client
contract". It would be a dead type duplicating `ControlRuntime` + `spans?`/`alerts`,
frozen forever at 1.0 for zero consumers.

## Affected packages

| Package | Change |
| --- | --- |
| `@openqueue/core` | Delete 2 functions + 2 interfaces from `runtime.ts`; prune `index.ts`. |
| `@openqueue/sdk` | `src/client.ts` re-export prune. `src/index.ts` (`export * from '@openqueue/core'`) auto-shrinks — no edit. |
| `@openqueue/client` | Test-only: conformance test retargets to `ControlRuntime`. Shipped dist byte-stable. |
| `@openqueue/world-bullmq` | Test-only: 2 test files port to `createControlRuntime`. README edit. |
| worker / cli / workbench / world-postgres / e2e | Zero source or test usage — untouched. |

## 1. Exact code edits

### `packages/core/src/runtime.ts`

Delete:
- `export interface QueueClientOptions` (lines 25–28) — exists only for the removed factory.
- `export interface QueueClient` (lines 30–42).
- `export async function createQueueClient` (lines 85–96).
- `export function createQueueClientFromWorld` (lines 98–120) — only caller is
  `createQueueClient`; not used by `createQueueWorker`, `createControlRuntime`,
  worker, or any test.

Collapse `FromWorldOptions` (lines 72–77) into `WorkerFromWorldOptions` — its only
remaining consumer:

```ts
export interface WorkerFromWorldOptions extends NamespaceOptions {
  tasks: TaskDefinition[];
  drains?: Array<QueueDrain | false | null | undefined>;
  /** Ownership cleanup (e.g. a caller-owned Redis connection) run last. */
  onClose?: () => Promise<void>;
  globalConcurrency?: number;
  queueConcurrency?: QueueConcurrency;
}
```

Remove the now-orphaned import `QueueCatalogStore` from the `./types` import block
(its only use was `QueueClient.catalog`). Keep everything else: `bindQueueRuntime`
(used twice by the worker path), `composeWorldRuntime`, `configureEnqueueTransport`,
`validateWorld`. `createQueueWorker` / `createQueueWorkerFromWorld` /
`CreateQueueWorkerOptions` / `QueueWorkerRuntime` are untouched.

### `packages/core/src/index.ts`

- Type block (lines 77–82): remove `QueueClient`, `QueueClientOptions`. Keep
  `CreateQueueWorkerOptions`, `QueueWorkerRuntime`.
- Line 83 becomes `export { createQueueWorker } from './runtime';`.
- KEEP `QueueRunPollOptions` and `QueueRunsApi` in the `./types` export block —
  they describe `QueueWorkerRuntime.runs` and `ControlRuntime.runs`. Runtime-object
  types, not client-factory types.

### `packages/core/src/enqueue.ts` (one string)

The `assertEnqueuer()` message (line 48) says "Boot a worker or client (or bind an
HTTP client) at process start." — "client" meant `createQueueClient`. Change to:
`'@openqueue/sdk: enqueue() called before the transport was configured. Boot a worker, or bind an HTTP client via @openqueue/sdk/client.'`
Grep tests for `before the transport was configured` first; update any pinned assertion.

### `packages/openqueue/src/client.ts`

Delete line 22 (`export { createQueueClient } from '@openqueue/core';`) and the whole
core type re-export block (lines 16–21: `QueueClient`, `QueueClientOptions`,
`QueueRunPollOptions`, `QueueRunsApi`). Post-removal the `./client` surface is exactly
the HTTP client (`@openqueue/client` re-exports plus the binding `createClient`).
Core's `QueueRunsApi`/`QueueRunPollOptions` remain importable from `@openqueue/sdk`
main. The `createClient` function, its `bindQueueRuntime(client)` call, and the
`@openqueue/client` re-export block (lines 8–15) are untouched. Do NOT add
`QueueRunPollOptions` from `@openqueue/client` to the sdk subpath.

## 2. Test fallout (complete list — 3 files)

1. `packages/client/src/__tests__/conformance.test.ts` — rewrite. Replace the
   `QueueClient` import with `import type { ControlRuntime } from '@openqueue/core/control';`.
   Line 24 becomes `const client: ControlRuntime = createClient({ host: 'http://x' });`
   and the `it` title becomes "satisfies the core ControlRuntime contract". Keep the
   `MutuallyAssignable` parity checks unchanged.

2. `packages/world-bullmq/src/__tests__/catalog.test.ts` — port, don't delete.
   Replace `createQueueClient({ world: worldBullmq({...}) })` with
   `createControlRuntime(worldBullmq({...}))`:
   - `import { createControlRuntime } from '@openqueue/core/control';`; drop
     `createQueueClient` from the `@openqueue/core` import (keep `task as defineTask`,
     `taskCatalogEntry`).
   - Line 235: `const client = await createControlRuntime(worldBullmq({ producer: redis }));`
   - Line 315: `const client = await createControlRuntime(worldBullmq({ producer: redis, storage }));`
   - Assertions unchanged. Retitle the two `it`s from "producer client …" to
     "producer runtime …".

3. `packages/world-bullmq/src/__tests__/client-close.test.ts` — port and rename to
   `control-close.test.ts`. Pins close-ownership semantics (owned transport closed,
   borrowed `producer` connection left open):
   - `const runtime = await createControlRuntime(worldBullmq({ producer: borrowed }), { namespace: \`client-${randomUUID().slice(0, 8)}\` });`
   - Same `trigger` → `close()` → borrowed-ping assertions. Update docstring/`describe`
     to "producer runtime close (real redis)".

No core, world-postgres, worker, workbench, sdk, or e2e test touches `createQueueClient`.

## 3. Docs edits

### `MIGRATION.md`
- Triage table row (line 12): label → "An app that called `configureEnqueue` /
  `createQueueClient`" (drop `({ redis })`); still points to §3.
- §3 body: prose gains "the in-process producer client is gone at 1.0 — app code
  dispatches to a deployed worker over HTTP." Code block keeps `before (0.1.x)` as-is;
  the `after` keeps only the current option-A lines (drop the "option A" label, delete
  option B and the `worldBullmq` import + "now async" note entirely). Append one
  sentence: hosts that embed a producer plane without HTTP mount the control API over
  `createControlRuntime` (`@openqueue/core/control`) — link the Two-plane docs.
- Quick map (lines 79–87): first entry becomes "`configureEnqueue` /
  `createQueueClient` → `createClient({ host })` (`@openqueue/client`, or
  `@openqueue/sdk/client` to auto-bind `task.trigger()`)". Rest stays.

### `site/content/docs/upgrading-to-1.0.mdx`
- Row line 70 (`configureEnqueue`): replacement → "`createClient({ host })` from
  `@openqueue/client` / `@openqueue/sdk/client` — connection-free HTTP dispatch."
- Add a row: "`createQueueClient`, `QueueClient`, `QueueClientOptions`" → "Removed —
  there is no in-process producer client at 1.0. Dispatch over HTTP with
  `createClient({ host })`; a host app embedding a producer plane uses
  `createControlRuntime` from `@openqueue/core/control` ([Two-plane](/docs/two-plane))."
- Lines 79–94: paragraph becomes "`createQueueWorker` now takes a `world` (a
  `WorldFactory`) instead of a `redis` connection". Code sample: keep `before (0.1.x)`
  line, replace both `after` variants with only the HTTP one; delete the `worldBullmq`
  import.

### `site/content/docs/tasks.mdx`
- Line 72: fix stale destructure — `const { runId } = await resizeImage.trigger(...)`
  (EnqueueResult is `{ runId, jobId }` at 1.0).
- Lines 87–88: replace the closing paragraph with the HTTP story: inside the worker
  process the runtime is ambient; in any other process bind the HTTP client once at
  boot — `createClient({ host })` from `@openqueue/sdk/client` binds `task.trigger()` /
  `trigger()` to go over HTTP. Include a 2–3 line code sample.

### `site/content/docs/quickstart.mdx`
§3 "Trigger from your app" silently presumes a bound runtime: prepend the binding to
the §3 sample — `import { createClient } from '@openqueue/sdk/client';
createClient({ host: 'http://localhost:8288' });` plus one sentence that the worker
serves the control API and the client makes `trigger()` go over HTTP.

### `packages/world-bullmq/README.md`
Line 20: parenthetical → "(`createQueueWorker({ world })` or `createControlRuntime`)".

Sweep result: no other docs/README mention `createQueueClient`. Do NOT edit
`.claude/plans/*` history.

## 4. `bindQueueRuntime` — unaffected, verified

`bindQueueRuntime(next: QueueRuntime)` in `packages/core/src/task.ts` takes the
internal `{ trigger, schedules? }` interface. Its three callers survive intact:
`createQueueWorkerFromWorld` (×2), `configureEnqueueTransport`, and sdk
`createClient`. `packages/openqueue/src/client.test.ts` needs no change and doubles
as the regression proof.

## 5. Sequencing and verification

1. Core edits → `cd packages/core && bun run typecheck && bun run test && bun run build`.
2. SDK edit → `cd packages/openqueue && bun run typecheck && bun run test && bun run build`.
3. Client conformance rewrite → `bunx turbo run test --filter=@openqueue/client`
   (needs built core dist for the `/control` subpath).
4. world-bullmq test ports → `bunx turbo run test --filter=@openqueue/world-bullmq`;
   run once with `REDIS_URL` set so `control-close.test.ts` executes rather than skips.
5. Docs.
6. Full gates: root `bun run lint && bun run typecheck && bun run build && bun run test`,
   then `bun run check:core`, `check:world`, `check:world-postgres`, `check:control`.
7. Freeze-artifact diff: build before/after, diff `packages/core/dist/index.d.ts`,
   `packages/openqueue/dist/index.d.ts`, `packages/openqueue/dist/client.d.ts`.
   Expected diff, exactly and only:
   - core/sdk `index.d.ts`: minus `interface QueueClientOptions`, `interface QueueClient`,
     `declare function createQueueClient(...)`, and the three names from the export list.
   - sdk `client.d.ts`: minus `createQueueClient`, `QueueClient`, `QueueClientOptions`,
     `QueueRunPollOptions`, `QueueRunsApi`.
   - Byte-stable: core `control.d.ts`, `types.d.ts`, `world.d.ts`, `auth.d.ts`,
     `drizzle.d.ts`; the entire `@openqueue/client` dist.
8. e2e: untouched; CI's four e2e jobs run unchanged as confirmation.

## 6. Commits (never squash)

1. Code + tests:
   ```
   feat(core)!: remove the in-process producer client (createQueueClient)

   Apps dispatch to a deployed worker over HTTP via @openqueue/client /
   @openqueue/sdk/client. Server-side composition is unchanged:
   createQueueWorker and createControlRuntime stay.

   BREAKING CHANGE: `createQueueClient`, `QueueClient`, and
   `QueueClientOptions` are removed from @openqueue/core and the
   @openqueue/sdk/client subpath (which also drops its `QueueRunPollOptions`
   / `QueueRunsApi` re-exports; both remain on @openqueue/sdk). Replace with
   `createClient({ host })`, or `createControlRuntime` from
   @openqueue/core/control for an embedded producer plane.
   ```
2. `docs: HTTP-only dispatch story (createQueueClient removal)` for MIGRATION.md +
   site + README.

## 7. Risks

- Post-1.0 there is no in-process producer client; reintroducing one is additive
  (safe). The conformance test now freezes `OpenQueueClient ⊆ ControlRuntime`.
- 0.1.x migrators on `createQueueClient({ redis })` lose the like-for-like port —
  MIGRATION §3 must land in the same release (it currently promises option B).
- sdk `./client` subpath shrink removes `QueueRunPollOptions`/`QueueRunsApi` from a
  0.1.x entry point; covered by the same major; must appear in the d.ts diff review.

## Flagged (separate housekeeping)

Root `CLAUDE.md` "Package imports" example still shows `import { createWorker } from
'@openqueue/core'` — removed in WS1 (it's `createQueueWorker` now).
