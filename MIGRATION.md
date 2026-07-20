# Migrating to OpenQueue 1.0

All `@openqueue/*` packages move from `0.1.x` to `1.0.0` together (lockstep).
This guide is organized by how you consume OpenQueue — find your row, apply
that section, done. The full reference lives in the docs:
[Upgrading to 1.0](https://openqueue.dev/docs/upgrading-to-1.0).

| You are… | What you must change |
| --- | --- |
| A worker app using `worker.config.ts` with `redis: { url }` | **Nothing but your Node/Bun version.** See [§1](#1-everyone-requirements) |
| An app that dispatches jobs over HTTP (`@openqueue/sdk/client` / `@openqueue/client`) | **Nothing.** |
| An app that called `configureEnqueue` / `createQueueClient` | [§3](#3-you-wired-a-runtime-by-hand) |
| Embedding the Workbench via `@openqueue/workbench/hono` | [§4](#4-you-embed-the-workbench) |
| Reading `EnqueueResult.id` / `.transportJobId`, or passing `ttl` | [§5](#5-type-changes) |
| Operating a deployment with JWT auth or an unset API token | [§6](#6-security-behavior-changes--read-before-deploying) |
| Authoring a custom world/transport | [§7](#7-you-author-a-world) |

---

## 1. Everyone: requirements

- **Node `>= 20.11.1` or Bun `>= 1.2`** for `core`, `sdk`, `client`,
  `workbench`, `world-bullmq`, `world-postgres`. (Node 18 support is dropped;
  both 18 and pre-20.11 are past EOL. 22+ recommended.)
- `@openqueue/worker` and `@openqueue/cli` remain **Bun-only**.
- Upgrade every `@openqueue/*` dependency to `1.0.0` at once — mixed versions
  across the lockstep group are unsupported.

## 2. The common path: no code changes

If your worker is config-driven, this still compiles and runs identically:

```ts
// worker.config.ts — unchanged from 0.1.x
import { defineConfig } from '@openqueue/sdk';

export default defineConfig({
  namespace: 'my-app',
  dirs: ['./worker'],
  redis: { url: process.env.REDIS_URL! },
});
```

`task()`, `task.trigger()`, `task.schedules.*`, `enqueueFlow()`,
`postgresAdapter`, drains, the error taxonomy, and `openqueue dev|build|start`
are all unchanged. Behind the scenes, `redis: { url }` is now sugar that
`@openqueue/worker` resolves to the new `@openqueue/world-bullmq` package —
you don't install or import anything for it.

One config nit if you used durable persistence:

```ts
// before                                        // after
storage: { adapter: postgresAdapter({ db }) }    storage: postgresAdapter({ db })
```

And if you imported the config type: `QueueConfig` → `OpenQueueConfig`
(the alias is gone).

## 3. You wired a runtime by hand

The BullMQ engine left `@openqueue/core` (core is now transport-neutral and
edge-clean), and the in-process producer client is gone at 1.0 — app code
dispatches to a deployed worker over HTTP. Low-level Redis-flavored exports
moved or died:

```ts
// before (0.1.x)
import { configureEnqueue, createQueueClient } from '@openqueue/core';
const client = createQueueClient({ redis: { url } });

// after (1.0) — connection-free HTTP dispatch
import { createClient } from '@openqueue/client'; // or '@openqueue/sdk/client' to auto-bind task.trigger()
const client = createClient({ host: 'https://worker.example.com', auth: { bearer: token } });
```

A host that embeds a producer plane without HTTP mounts the control API over
`createControlRuntime` (`@openqueue/core/control`) — see
[Two-plane](https://openqueue.dev/docs/two-plane).

Removed → replacement quick map: `configureEnqueue` / `createQueueClient` →
`createClient({ host })` (`@openqueue/client`, or `@openqueue/sdk/client` to
auto-bind `task.trigger()`) · `createConnection`/`closeConnection` → the
world owns connections (`worldBullmq({ url })`, or pass your own
`producer`/`consumer`) · `createQueue`/`createWorker`/`createQueueSchedules` →
`createQueueWorker({ world, tasks })` and `runtime.schedules` · catalog Redis
helpers → `client.catalog` / `runtime.catalog` · `bullPrefix` →
`worldBullmq({ prefix })`. On the runtime object, `queues`/`workers` became
`transport`/`consumers` (use `isBullmqTransport(runtime.transport)` to reach
raw BullMQ `Queue`s).

## 4. You embed the Workbench

- `@openqueue/workbench/hono` → **`@openqueue/workbench/h3`**. The adapter
  returns [h3](https://h3.dev) apps now; mount with `app.mount(prefix, …)`.
  Everything else (routes, dashboard, auth) is identical.
- Not on h3? Use `createFetchHandler` from the main entry — a plain
  `(Request) => Response` that mounts anywhere fetch-native (Hono, Elysia,
  Next), or through h3's `toNodeHandler` for Express/Koa:

  ```ts
  expressApp.use('/admin/jobs', toNodeHandler(app));
  ```
- `hono`, `@hono/zod-openapi`, and `@scalar/hono-api-reference` are no longer
  dependencies; OpenAPI is generated framework-free.
- Heads-up on non-BullMQ worlds (`world-postgres`): the dashboard's Runs page
  reads BullMQ directly and renders empty — run history lives on the
  `/openqueue/v1` control API and the client.

## 5. Type changes

- **`EnqueueResult` is `{ runId, jobId }`.** The duplicate `id` (≡ `runId`)
  and `transportJobId` (≡ `jobId`) fields are gone. `QueueRun.transportJobId`
  (on run records) stays.
- **`ttl` is removed** from `EnqueueOptions` and task definitions — it was a
  silent no-op on every transport, so there is nothing to migrate. If you need a
  run-duration limit, enforce it in the handler (e.g. `AbortSignal.timeout`
  around external calls).
- `WorkerConfig` / `TelemetryConfig` / `defineWorkerConfig` are deleted (dead
  scaffolding; OTel wires through your tracer provider).

## 6. Security behavior changes — read before deploying

These are intentional fail-closed changes that can surface as new 401s:

- **`tenantClaim` fails closed.** A validly-signed JWT whose configured tenant
  claim is missing or non-string is now rejected (401) instead of being granted
  cross-tenant access.
- **The control API is locked in production when unconfigured.** With neither
  `api.token` nor `api.auth` set, `/openqueue/v1` returns 401 under
  `NODE_ENV=production` (open in dev, loudly logged). `api.auth: []` always
  401s.
- Wire envelopes tightened: unknown control routes → `404 not_found` envelope;
  unsupported transport capability → `501 unsupported_capability`; invalid
  list-query values → `400` with issues (previously silently ignored).

## 7. You author a world

- `WorldContext` flattened: `ctx.namespace` is now a `string`.
- The contract is frozen at `WORLD_SPEC_VERSION = 1` — implement
  `QueueTransport` (+ honest `capabilities` flags) and a `QueueStorage`, and
  the conformance expectations documented in
  [Worlds](https://openqueue.dev/docs/worlds) apply.

---

**Semver from here:** the sdk/core surface (index + `./auth`, `./control`,
`./drizzle`, `./types`, `./world`), the client + `/openqueue/v1` wire
contract, `OpenQueueConfig`, the CLI commands, and the world contract are
frozen — breaking changes only in 2.0. Dashboard internals are not frozen and
evolve freely.
