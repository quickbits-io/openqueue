# Blueprint — Phase 1: Wire contract + connection-free client

> Produced by the architect agent. Implementation follows the sequencing in (d); verify each stage before the next.

## (a) Design summary

**Wire contract lives in the new `@openqueue/client` package; the server imports it.** The dependency-graph constraint forces this direction: the client may not have ioredis/bullmq/drizzle anywhere in its install graph, so it cannot depend on `@openqueue/core` (not even for a types-only subpath — `dependencies` pulls core's whole install tree). Instead, `@openqueue/client` owns the zod wire schemas + self-contained domain types (structurally identical to core's `QueueRun`/`QueueSchedule`/`EnqueueResult`), and core-parity is enforced by compile-time conformance tests using core as a **devDependency** (erased at publish, no cycle: core never imports client). The rejected alternative — a `@openqueue/core/wire` entry — keeps one source of truth in core but makes `npm i @openqueue/client` install ioredis/bullmq/drizzle, which is exactly what the decision forbids.

**The `/openqueue/v1` route table lives in workbench (`src/api/v1/`), mounted by the worker.** Worker already depends on workbench statically and unconditionally, so no new edge is created; workbench already owns the transport-agnostic `RouteDef`/`Handler` types, the Hono dispatch pattern, and is Node 18+/Bun portable (future non-Bun hosts can mount it). The v1 module takes a **narrow `ControlRuntime` interface** — not `WorkbenchCore` — so it is fully independent of the dashboard. Per workbench's existing convention (see the header comment in `src/hono.ts`), the transport-agnostic `buildControlRouteTable` exports from the main entry and the Hono-returning `buildControlApp` from the `./hono` entry. Putting routes in worker was rejected (Bun-only published surface, no reuse); putting them in core was rejected (core must stay hono-free, and core→client would create a build cycle with client's devDep on core).

**One core addition: run cancellation.** `POST /runs/:id/cancel` has no core primitive today (`RunStatus 'canceled'` exists but nothing sets it). Add `runs.cancel(id)` to `QueueRunsApi` plus a `{ type: 'cancel' }` drain event — verified safe: `state.handle` writes the run snapshot regardless of event type, drizzle's `persistRun` takes `type: string` into a plain-text `run_events.type` column, and all in-repo drains are non-exhaustive if-chains.

**Client conformance is honest, not forced.** `createClient()` returns `OpenQueueClient` implementing every wire-capable `QueueClient` member (`catalog`, `trigger`, `schedules`, `runs`, `close`) — asserted at compile time as `Omit<QueueClient, 'alerts' | 'spans'>` — and simply omits `alerts`/`spans` (out of v1 per decisions) rather than shipping throwing stubs that lie in the type system. `bindQueueRuntime` only requires `{ trigger, schedules? }` (core `task.ts:19-26`), so `myTask.trigger()` works unchanged. Binding itself happens in `@openqueue/sdk/client`'s `createClient` wrapper (sdk already loads core, so importing `bindQueueRuntime` there is free), keeping `@openqueue/client` runtime-import-free of core and edge-safe.

**Auth**: bearer token(s) on `config.api.token`, timing-safe compare, eve's placeholder semantics — unconfigured + `NODE_ENV=production` ⇒ everything except `/health` is 401 (fail-closed); unconfigured in dev ⇒ open, loudly logged. The config field is shaped so Phase 2 adds `api.auth: AuthStrategy[]` alongside without breaking anything.

## (b) Affected packages

| Package | Change | Downstream impact |
| --- | --- | --- |
| `@openqueue/core` | `runs.cancel` + `CancelRunResult` + `'cancel'` drain event; `QueueConfig.api` field | All packages re-consume; `QueueDrainEvent` union grows (additive; breaks only user exhaustive switches at compile time) |
| **`@openqueue/client`** (new, `packages/client`) | Wire schemas + fetch-only client | Leaf; consumed by workbench (schemas) and sdk (re-export) |
| `@openqueue/workbench` | New `src/api/v1/` control module; gains dep on `@openqueue/client`; gains `test` script | Worker mounts it |
| `@openqueue/worker` | Mount `/openqueue/v1` unconditionally; reserved-prefix guard | — |
| `@openqueue/sdk` | `./client` subpath gains binding `createClient` + re-exports; gains dep on `@openqueue/client` | Users |
| `@openqueue/cli` | untouched | — |

## (c) File-level plan

### 1. `@openqueue/core`

**`packages/core/src/types.ts`** (modify)

```ts
export type QueueDrainEvent =
  | { type: 'enqueue'; run: QueueRunSnapshot }
  | { type: 'start'; run: QueueRunSnapshot }
  | { type: 'progress'; run: QueueRunSnapshot; patch: Record<string, unknown> }
  | { type: 'complete'; run: QueueRunSnapshot }
  | { type: 'fail'; run: QueueRunSnapshot }
  | { type: 'cancel'; run: QueueRunSnapshot };          // NEW

export type CancelRunResult =                            // NEW
  | { outcome: 'canceled'; run: QueueRun }
  | { outcome: 'not_found' }
  | { outcome: 'already_finished'; run: QueueRun }
  | { outcome: 'not_cancelable'; run: QueueRun; reason: 'executing' };

export interface QueueRunsApi extends QueueRunStore {
  retrieve(id: string): Promise<QueueRun | undefined>;
  poll(id: string, options?: QueueRunPollOptions): Promise<QueueRun>;
  cancel(id: string): Promise<CancelRunResult>;          // NEW
}
```

**`packages/core/src/cancel.ts`** (new)

```ts
import type { Queue } from 'bullmq';
import type { CancelRunResult, QueueDrain, QueueRun, QueueRunStore } from './types';

interface CancelRunDeps {
  store: QueueRunStore;
  getQueue(name: string): Queue;
  drain: QueueDrain;
}

export function createRunCancel(deps: CancelRunDeps): (id: string) => Promise<CancelRunResult>;
```

Logic: `store.list({ id, limit: 1 })` → `not_found` / `already_finished` (terminal set, reuse the one in `runs.ts` — export `isTerminalRunStatus` from there) / `'executing'` → `not_cancelable`. Otherwise `getQueue(run.queue).getJob(run.transportJobId ?? run.id)`; if present, `job.remove()` in try/catch (BullMQ throws on active/locked jobs → `not_cancelable`). On success build a `QueueRunSnapshot` (`status: 'canceled'`, `willRetry: false`, `finishedAt: new Date()`, `attempt: (job?.attemptsMade ?? 0) + 1`, `maxAttempts: job?.opts.attempts ?? 1`, name = `run.task`) and `await deps.drain.handle({ type: 'cancel', run: snapshot })`; return `{ outcome: 'canceled', run: { ...run, status: 'canceled', finishedAt, updatedAt } }`.

**`packages/core/src/runs.ts`** (modify) — `createRunsApi(store: QueueRunStore, cancel: (id: string) => Promise<CancelRunResult>): QueueRunsApi`; export `isTerminalRunStatus`.

**`packages/core/src/runtime.ts`** (modify) — both factories wire cancel:
- `createQueueWorker`: `getQueue: (name) => queues.get(name) ?? cacheInto(queues, createQueue(name, connection.producer, namespace))` (cached queues are closed by the existing close loop).
- `createQueueClient`: local `Map<string, Queue>` filled via `createQueue(name, redis, namespace)`; close them in `close()`.
- Pass the already-composed `drain` to `createRunCancel`.

**`packages/core/src/drains.ts`** (modify) — add a `CANCEL` branch to `consoleDrain` (gray/red tag, same prefix format).

**`packages/core/src/config.ts`** (modify) — worker config addition:

```ts
export interface QueueConfig {
  // ...existing...
  api?: {
    /** Bearer token(s) for the /openqueue/v1 control API. When unset, the API
     *  is open in development and locked (401) when NODE_ENV=production. */
    token?: string | string[];
  };
}
```

**`packages/core/src/index.ts`** (modify) — export `type CancelRunResult`, `isTerminalRunStatus`.

**Tests**: new `src/__tests__/cancel.test.ts` (stub store/queue/drain; cover all four outcomes + remove-throws path + drain event assertion); update `src/__tests__/runs.test.ts` call sites for the new `createRunsApi` signature (pass a stub cancel).

### 2. `@openqueue/client` (new package, `packages/client/`)

**`package.json`** — mirror `packages/openqueue`'s manifest style:

```jsonc
{
  "name": "@openqueue/client",
  "version": "0.1.4",                       // lockstep with the group
  "description": "Fetch-only HTTP client for a deployed OpenQueue worker — trigger tasks, read runs, manage schedules with zero Redis/DB connections.",
  "type": "module", "sideEffects": false,
  "main": "./dist/index.js", "module": "./dist/index.js", "types": "./dist/index.d.ts",
  "exports": {
    ".":      { "types": "./dist/index.d.ts", "import": "./dist/index.js", "default": "./dist/index.js" },
    "./wire": { "types": "./dist/wire.d.ts",  "import": "./dist/wire.js",  "default": "./dist/wire.js" }
  },
  "files": ["dist"],
  "engines": { "node": ">=18" },
  "publishConfig": { "access": "public" },
  "scripts": { /* build/dev/clean/lint/format/test/typecheck — copy from core */ },
  "dependencies": { "zod": "^4.1.13" },
  "devDependencies": {
    "@openqueue/core": "workspace:*",
    "@types/node": "^22.10.10", "tsup": "^8.5.0", "typescript": "^5.9.3", "vitest": "^4.0.18"
  }
}
```

**`tsup.config.ts`** — entries `{ index: 'src/index.ts', wire: 'src/wire.ts' }`, `format: ['esm']`, `dts: true`, `sourcemap`, `clean`, `treeshake`, `target: 'node18'`. **`tsconfig.json`** — copy core's. **`README.md`** — short usage doc (all published packages have one).

**`src/wire.ts`** — the frozen contract. zod schemas + inferred wire types; dates are ISO strings on the wire. Key exports (implementer: verify zod-4 APIs `z.iso.datetime()`, `z.looseObject` via context7):

```ts
export const CONTROL_PREFIX = '/openqueue/v1';

export const runStatusSchema = z.enum(['queued','delayed','executing','reattempting',
  'waiting_children','completed','failed','canceled','timed_out','expired']);
export const backoffSchema = z.object({ type: z.enum(['exponential','fixed']), delay: z.number() });
export interface WireSerializedError { name: string; message: string; stack?: string;
  code?: string; retryable?: boolean; cause?: WireSerializedError }
export const serializedErrorSchema: z.ZodType<WireSerializedError> = z.lazy(/* recursive */);
export const enqueueMetaSchema = z.looseObject({
  tags: z.array(z.string()).optional(), parentRunId: z.string().optional(),
  scheduleId: z.string().optional(), scheduleExternalId: z.string().optional() });

export const wireRunSchema = z.object({
  id: z.string(), transportJobId: z.string().optional(), task: z.string(), queue: z.string(),
  status: runStatusSchema, input: z.unknown(), output: z.unknown().optional(),
  error: serializedErrorSchema.optional(), meta: enqueueMetaSchema,
  metadata: z.record(z.string(), z.unknown()), tags: z.array(z.string()),
  scheduleId: z.string().optional(), scheduleExternalId: z.string().optional(),
  createdAt: z.iso.datetime(), startedAt: z.iso.datetime().optional(),
  finishedAt: z.iso.datetime().optional(), updatedAt: z.iso.datetime() });
export const wireRunListSchema = z.object({ data: z.array(wireRunSchema),
  cursor: z.string().optional(), hasMore: z.boolean() });

export const enqueueOptionsSchema = z.object({ runId: z.string().optional(), jobId: z.string().optional(),
  delay: z.number().int().nonnegative().optional(), priority: z.number().int().optional(),
  attempts: z.number().int().positive().optional(), backoff: z.union([backoffSchema, z.number()]).optional(),
  ttl: z.number().int().positive().optional(), meta: enqueueMetaSchema.optional() });
export const enqueueRequestSchema = z.object({ task: z.string().min(1),
  input: z.unknown().optional(), options: enqueueOptionsSchema.optional() });
export const enqueueResultSchema = z.object({ id: z.string(), runId: z.string(),
  jobId: z.string(), transportJobId: z.string() });

export const wireScheduleSchema = z.object({ id: z.string(), type: z.enum(['DECLARATIVE','IMPERATIVE']),
  task: z.string(), input: z.unknown().optional(), active: z.boolean(), cron: z.string(),
  timezone: z.string(), externalId: z.string().optional(), deduplicationKey: z.string().optional(),
  meta: enqueueMetaSchema, nextRun: z.iso.datetime().optional(), lastRun: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() });
export const createScheduleRequestSchema = z.object({ task: z.string().min(1), input: z.unknown().optional(),
  cron: z.string().min(1), timezone: z.string().optional(), externalId: z.string().optional(),
  deduplicationKey: z.string().min(1), meta: enqueueMetaSchema.optional() });
export const updateScheduleRequestSchema = z.object({ task: z.string().optional(), input: z.unknown().optional(),
  cron: z.string().optional(), timezone: z.string().optional(),
  externalId: z.string().nullable().optional(), deduplicationKey: z.string().optional(),
  meta: enqueueMetaSchema.optional() });

export const wireCatalogEntrySchema = z.object({ id: z.string(), name: z.string(), queue: z.string(),
  attempts: z.number(), backoff: backoffSchema, concurrency: z.number(), ttl: z.number().optional(),
  maxStalledCount: z.number().optional(), cron: z.string().optional(), tags: z.array(z.string()),
  description: z.string().optional(), schema: z.object({ type: z.string() }).optional(),
  updatedAt: z.string(), version: z.string() });
export const catalogResponseSchema = z.object({ tasks: z.array(wireCatalogEntrySchema) });

export const cancelRunResponseSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('canceled'), run: wireRunSchema }),
  z.object({ outcome: z.literal('already_finished'), run: wireRunSchema }),
  z.object({ outcome: z.literal('not_cancelable'), run: wireRunSchema, reason: z.literal('executing') })]);

export const healthResponseSchema = z.object({ ok: z.boolean() });
export const infoResponseSchema = z.object({ service: z.literal('openqueue'),
  apiVersion: z.literal(1), namespace: z.string(), tasks: z.number().int(), queues: z.array(z.string()) });

/** Server-known codes; wire schema keeps `code` a plain string for forward compat. */
export type WireErrorCode = 'unauthorized' | 'invalid_request' | 'task_not_found'
  | 'run_not_found' | 'schedule_not_found' | 'internal';
export const errorResponseSchema = z.object({ error: z.object({ code: z.string(),
  message: z.string(), issues: z.array(z.object({ path: z.string(), message: z.string() })).optional() }) });
// plus `export type WireRun = z.infer<...>` etc. for every schema
```

**`src/types.ts`** — Date-hydrated domain types, structurally identical to core's (`RunStatus`, `SerializedError`, `BackoffOptions`, `EnqueueMeta`, `EnqueueOptions`, `EnqueueResult`, `QueueRun`, `QueueRunListOptions` (with `timeRange: { start: Date; end: Date }`), `QueueRunListResult`, `QueueRunPollOptions`, `QueueSchedule`, `QueueScheduleListOptions`, `CancelRunResult`, `QueueCatalogEntry`), plus:

```ts
/** Structural supertype of core's TaskDefinition — accepts any task() value. */
export interface TaskRef<I = unknown, O = unknown> {
  id: string;
  schema?: { parse(input: unknown): I };
  __input?: I;
  __output?: O;
}
export interface CreateScheduleOptions { task: string | TaskRef; input?: unknown; cron: string;
  timezone?: string; externalId?: string; deduplicationKey: string; meta?: EnqueueMeta }
export interface UpdateScheduleOptions { task?: string | TaskRef; input?: unknown; cron?: string;
  timezone?: string; externalId?: string | null; deduplicationKey?: string; meta?: EnqueueMeta }
```

(These are deliberately *wider* in `task` than core's, so core's `CreateQueueScheduleOptions`/`TaskDefinition` remain assignable — required for `QueueClient` conformance under parameter contravariance.)

**`src/errors.ts`**

```ts
export type ClientErrorCode = 'unauthorized' | 'forbidden' | 'not_found'
  | 'invalid_request' | 'server_error' | 'network_error' | 'invalid_response';
export class OpenQueueClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status?: number;
  /** Raw wire error body when the server sent one. */
  readonly details?: unknown;
  constructor(code: ClientErrorCode, message: string, opts?: { status?: number; details?: unknown; cause?: unknown });
}
```

**`src/http.ts`** — transport internals:

```ts
export type TokenValue = string | (() => string | Promise<string>);
export interface ClientAuth { bearer: TokenValue }
interface HttpOptions { host: string; auth?: ClientAuth; fetch?: typeof globalThis.fetch }

// Resolves the token PER REQUEST (rotating tokens survive), builds
// `${host}${CONTROL_PREFIX}${path}?query`, sets Authorization/Content-Type,
// maps failures: fetch rejection → 'network_error'; 401/403 → codes; 404 → caller
// decides (helper exposes status); other non-2xx → parse errorResponseSchema →
// 'invalid_request'/'server_error'; 2xx → schema.safeParse(json) else 'invalid_response'.
export function createHttp(options: HttpOptions): {
  request<T>(args: { method: 'GET'|'POST'|'PATCH'|'DELETE'; path: string;
    query?: Record<string, string | undefined>; body?: unknown;
    schema: z.ZodType<T> }): Promise<{ status: number; data: T }>;
  requestOrStatus<T>(/* same, plus */ expect: number[]): Promise<{ status: number; data?: T; error?: WireErrorBody }>;
};
```

**`src/client.ts`** — the client:

```ts
export interface ClientOptions {
  /** Absolute origin (server-to-server) or same-origin prefix (behind a proxy). */
  host: string;
  auth?: ClientAuth;
  /** Custom fetch (tests, instrumented runtimes). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export interface OpenQueueClient {
  catalog: { read(): Promise<QueueCatalogEntry[]>; resolve(id: string): Promise<QueueCatalogEntry | undefined> };
  trigger<I, O = unknown>(target: string | TaskRef<I, O>, input: I, opts?: EnqueueOptions): Promise<EnqueueResult>;
  runs: {
    list(options?: QueueRunListOptions): Promise<QueueRunListResult>;
    retrieve(id: string): Promise<QueueRun | undefined>;          // 404 → undefined
    poll(id: string, options?: QueueRunPollOptions): Promise<QueueRun>; // client-side loop, 1000ms/500 defaults
    cancel(id: string): Promise<CancelRunResult>;                 // 404 → { outcome: 'not_found' }
  };
  schedules: {
    create(options: CreateScheduleOptions): Promise<QueueSchedule>;
    retrieve(id: string): Promise<QueueSchedule>;                 // 404 → throws (core parity)
    list(options?: QueueScheduleListOptions): Promise<QueueSchedule[]>;
    runNow(id: string): Promise<EnqueueResult>;
    update(id: string, options: UpdateScheduleOptions): Promise<QueueSchedule>;
    activate(id: string): Promise<QueueSchedule>;
    deactivate(id: string): Promise<QueueSchedule>;
    delete(id: string): Promise<boolean>;
    timezones(): Promise<string[]>;                               // local Intl.supportedValuesOf, no wire call
  };
  health(): Promise<{ ok: boolean }>;
  info(): Promise<WorkerInfo>;
  close(): Promise<void>;                                         // no-op
}

export function createClient(options: ClientOptions): OpenQueueClient;
```

Implementation notes: `trigger` sends `{ task: id, input, options }` to `POST /jobs` — if `target` is a `TaskRef` with `schema`, parse input locally first (parity with core `enqueue()`); dates hydrated via small `toRun(wire)`/`toSchedule(wire)` mappers; query serialization: `meta` → JSON string, `timeRange` → `start`/`end` ISO params, `sort` → `field:direction`, `active` → `'true'|'false'`. **No `bindQueueRuntime` here** — that is the sdk wrapper's job.

**`src/index.ts`** — export `createClient`, `OpenQueueClientError`, all public types (`ClientOptions`, `ClientAuth`, `TokenValue`, `OpenQueueClient`, `ClientErrorCode`, domain types, `TaskRef`). Keep `./wire` as the schema entry; index exports only the domain types.

**Tests** (`src/__tests__/`):
- `client.test.ts` — stub `fetch` via `ClientOptions.fetch`: auth header set from static string AND from async resolver called per request; trigger body shape; `runs.retrieve` 404→undefined; `poll` loop to terminal; `cancel` status→outcome mapping (200/409/404); schedule CRUD paths/methods; error mapping (401→`unauthorized`, network reject→`network_error`, garbage 200 body→`invalid_response`); `createdAt instanceof Date`.
- `conformance.test.ts` — the load-bearing compile-time check (enforced by `tsc --noEmit`, exercised trivially at runtime):

```ts
import type { EnqueueResult, QueueClient, QueueRun, QueueSchedule } from '@openqueue/core';
import type * as local from '../types';

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const runParity: MutuallyAssignable<QueueRun, local.QueueRun> = true;
const scheduleParity: MutuallyAssignable<QueueSchedule, local.QueueSchedule> = true;
const enqueueParity: MutuallyAssignable<EnqueueResult, local.EnqueueResult> = true;

it('satisfies the core QueueClient contract minus alerts/spans', () => {
  const client: Omit<QueueClient, 'alerts' | 'spans'> = createClient({ host: 'http://x' });
  expect(client && runParity && scheduleParity && enqueueParity).toBeTruthy();
});
```

- `dependencies.test.ts` — tripwire: read own `package.json`, assert `Object.keys(dependencies)` equals `['zod']` and there are no `peerDependencies`.

### 3. `@openqueue/workbench`

**`packages/workbench/src/api/v1/auth.ts`** (new) — pure, unit-testable:

```ts
export type ControlAuth =
  | { mode: 'token'; tokens: string[] }
  | { mode: 'open' }     // unconfigured, non-production
  | { mode: 'locked' };  // unconfigured, NODE_ENV=production — always 401

export function resolveControlAuth(token: string | string[] | undefined, nodeEnv: string | undefined): ControlAuth;
/** Extracts `Authorization: Bearer <t>` and compares timing-safe (node:crypto sha256 + timingSafeEqual). */
export function authorizeControlRequest(auth: ControlAuth, header: string | undefined):
  { ok: true } | { ok: false; code: 'unauthorized'; message: string };
```

**`packages/workbench/src/api/v1/serialize.ts`** (new) — server-side converters, type-checked against the wire types:

```ts
import type { WireRun, WireSchedule, WireCatalogEntry } from '@openqueue/client/wire';
export function wireRun(run: QueueRun): WireRun;                 // Date → toISOString()
export function wireSchedule(s: QueueSchedule): WireSchedule;
export function wireCatalogEntry(e: QueueCatalogEntry): WireCatalogEntry;
export function toRunListOptions(q: Record<string, string | undefined>): QueueRunListOptions;
export function toScheduleListOptions(q: Record<string, string | undefined>): QueueScheduleListOptions;
export function toEnqueueOptions(o: WireEnqueueOptions | undefined): EnqueueOptions | undefined;
export function controlError(code: WireErrorCode, message: string,
  issues?: { path: string; message: string }[]): HandlerResult;  // { status, body: { error: {...} } }
```

**`packages/workbench/src/api/v1/routes.ts`** (new) — the table, reusing `RouteDef`/`HandlerInput` from `../handlers` and wire schemas from `@openqueue/client/wire` for `meta.body` + body validation (same `parseBody` pattern as `handlers.ts`; write a local copy of the tiny `parseBody`, do not refactor `handlers.ts`):

```ts
export interface ControlRuntime {
  trigger<I, O = unknown>(id: string | TaskDefinition<I, O>, input: I, opts?: EnqueueOptions): Promise<EnqueueResult>;
  runs: QueueRunsApi;
  schedules: QueueSchedulesApi;
  catalog: QueueCatalogEntry[];
}
export interface ControlApiOptions {
  runtime: ControlRuntime;                 // QueueWorkerRuntime is structurally assignable
  auth: { token?: string | string[] };
  info: { namespace: string };
}
export function buildControlRouteTable(options: ControlApiOptions): RouteDef[];
```

Routes (paths relative to the `/openqueue/v1` mount):

| Route | Handler behavior | Status |
| --- | --- | --- |
| `GET /health` | `{ ok: true }` — registered before auth middleware, always public | 200 |
| `GET /info` | `{ service: 'openqueue', apiVersion: 1, namespace, tasks: catalog.length, queues: sortedUnique(catalog.map(e => e.queue)) }` | 200 |
| `POST /jobs` | validate `enqueueRequestSchema`; `catalog.some(e => e.id === task)` else `task_not_found` 404; `runtime.trigger(task, input, toEnqueueOptions(options))` → `EnqueueResult`. (Input is validated by the task's zod schema at execution, not enqueue — existing trigger-by-id semantics; document in route summary.) Zod-looking throw → 400 `invalid_request` with issues; other throw → 500 `internal` | 201 |
| `GET /runs` | `runtime.runs.list(toRunListOptions(query))` → `{ data: data.map(wireRun), cursor, hasMore }` | 200 |
| `GET /runs/:id` | `retrieve` → `wireRun` or 404 `run_not_found` | 200 |
| `POST /runs/:id/cancel` | `runtime.runs.cancel(id)`: `canceled`→200, `already_finished`/`not_cancelable`→409 (body carries `outcome`), `not_found`→404 `run_not_found` | 200/409/404 |
| `GET /schedules` | `schedules.list(toScheduleListOptions(query))` | 200 |
| `POST /schedules` | validate `createScheduleRequestSchema` → `schedules.create` → `wireSchedule` | 201 |
| `GET /schedules/:id` | `schedules.retrieve` (throw → 404 `schedule_not_found`) | 200 |
| `PATCH /schedules/:id` | validate `updateScheduleRequestSchema` → `schedules.update` | 200 |
| `DELETE /schedules/:id` | `schedules.delete` → `{ deleted: true }` or 404 | 200 |
| `POST /schedules/:id/run` | `schedules.runNow` → `EnqueueResult` | 200 |
| `POST /schedules/:id/activate` / `.../deactivate` | → `wireSchedule` | 200 |
| `GET /catalog` | `{ tasks: catalog.map(wireCatalogEntry) }` | 200 |

(Streaming namespace room per decisions: `GET /runs/:id/stream` is intentionally unclaimed — nothing to do now.)

**`packages/workbench/src/api/v1/app.ts`** (new) — Hono assembly:

```ts
export function buildControlApp(options: ControlApiOptions): Hono;
```

Order matters (Hono middleware only guards handlers registered after it): register `GET /health` first, then `app.use('*', authMiddleware)` using `resolveControlAuth`/`authorizeControlRequest` (401 body = `controlError('unauthorized', ...)` + `WWW-Authenticate: Bearer`), then dispatch the remaining `RouteDef`s with a local 15-line copy of `router.ts`'s `dispatch`.

**`packages/workbench/src/index.ts`** (modify) — add `export { buildControlRouteTable, type ControlApiOptions, type ControlRuntime } from './api/v1/routes';` plus `resolveControlAuth`/`ControlAuth` (worker logs the mode).
**`packages/workbench/src/hono.ts`** (modify) — add `export { buildControlApp } from './api/v1/app';` (Hono types stay out of the main entry, per the file's own header contract).
**`packages/workbench/package.json`** (modify) — add `"@openqueue/client": "workspace:*"` to dependencies; add `"test": "vitest run"` script + `vitest` devDep.

**Tests** (`src/api/v1/__tests__/`):
- `auth.test.ts` — matrix: token match / mismatch / missing header; unconfigured+production → locked; unconfigured+dev → open; multiple tokens.
- `routes.test.ts` — handlers against a stub `ControlRuntime` (enqueue 201 + result passthrough; unknown task 404 with `code: 'task_not_found'`; runs query parsing incl. meta/timeRange/sort; cancel outcome→status mapping; schedules CRUD; health public vs catalog 401 through `buildControlApp.request()`).
- `control-integration.test.ts` — the Phase 1 integration test, `describe.skipIf(!process.env.REDIS_URL)`: `createQueueWorker` (core, real Redis, inline test task with output) → `buildControlApp({ runtime, auth: { token: 't' }, info })` → `createClient({ host: 'http://control.test', auth: { bearer: 't' }, fetch: (input, init) => app.fetch(new Request(input, init)) })` — the client instance is constructed with **no Redis/DB config** — `trigger` → `runs.poll` → assert `status: 'completed'` + output; schedule create/list/runNow/delete round-trip; cancel of a delayed run → `outcome: 'canceled'` and run reads back `canceled`. This exercises the full wire contract minus TCP; a true two-process smoke over `startWorkerApp` + a real port stays a manual step via `examples/basic` (Bun-only `Bun.serve` can't run under vitest/Node).

### 4. `@openqueue/worker`

**`packages/worker/src/index.ts`** (modify) — in `startWorkerApp`, after `createHealthServer` and before the workbench mount:

```ts
import { resolveControlAuth } from '@openqueue/workbench';
import { buildControlApp } from '@openqueue/workbench/hono';

const controlAuth = resolveControlAuth(config.api?.token, process.env.NODE_ENV);
health.route('/openqueue/v1', buildControlApp({
  runtime,
  auth: { token: config.api?.token },
  info: { namespace: config.namespace },
}));
console.log(`[openqueue] control API mounted at /openqueue/v1 (auth: ${controlAuth.mode})`);
```

In `validateConfig`: reject `config.workbench.basePath` of `/openqueue` or `/openqueue/...` (reserved prefix).

### 5. `@openqueue/sdk`

**`packages/openqueue/src/client.ts`** (modify) — keep existing core re-exports; add:

```ts
import { bindQueueRuntime } from '@openqueue/core';
import { createClient as createHttpClient, type ClientOptions, type OpenQueueClient } from '@openqueue/client';

export {
  OpenQueueClientError,
  type ClientAuth, type ClientErrorCode, type ClientOptions,
  type OpenQueueClient, type TokenValue,
} from '@openqueue/client';

/**
 * Create an HTTP client for a deployed worker and bind it as the process task
 * runtime, so `myTask.trigger()` / `myTask.schedules.*` go over HTTP with no
 * Redis/DB connection. For an unbound client (edge, multi-target), import
 * `createClient` from '@openqueue/client' directly.
 */
export function createClient(options: ClientOptions): OpenQueueClient {
  const client = createHttpClient(options);
  bindQueueRuntime(client);
  return client;
}
```

Use **named** re-exports (no `export *`) — client's domain type names (`QueueRun` etc.) intentionally collide with core's; sdk consumers keep core's. **`package.json`**: add `"@openqueue/client": "workspace:*"` dependency.

### 6. Repo plumbing

- `release-please-config.json` — add `"client"` to the `linked-versions` components array and `"packages/client": { "component": "client" }` to `packages`.
- `.release-please-manifest.json` — add `"packages/client": "0.1.4"`.
- `scripts/publish.ts` auto-discovers `packages/*` — no change. Root `workspaces` glob covers it — run `bun install` to register + refresh `bun.lock`.
- `CLAUDE.md` — add the client row to the Architecture table (six publishable packages now).

## (d) Sequencing

1. **Core cancel** (`types.ts`, `cancel.ts`, `runs.ts`, `runtime.ts`, `drains.ts`, `index.ts`, tests). Verify: `cd packages/core && bun run test && bun run typecheck && bun run build`.
2. **`@openqueue/client` scaffold + wire + client** (whole package). Then root `bun install`. Verify: `cd packages/client && bun run build && bun run typecheck && bun run test`; additionally grep `dist/*.d.ts` for `'@openqueue/core'` — must be absent (self-contained types), and grep `dist/*.js` for `ioredis|bullmq|drizzle` — must be absent.
3. **Workbench v1 module** (auth/serialize/routes/app, exports, package.json dep + test script). Verify: `cd packages/workbench && bun run build && bun run typecheck && bun run test` (unit tests; note this also awakens the four dormant workbench test files — if any fail for pre-existing reasons, report, don't silently fix).
4. **Worker mount + core config field + sdk subpath + release-please/manifest/CLAUDE.md**. Verify: root `bun run build && bun run typecheck && bun run test`.
5. **Integration test** (workbench, Redis-gated). Verify locally with `REDIS_URL=redis://localhost:6379 bun run test` in `packages/workbench`; confirm it skips cleanly without `REDIS_URL`. Manual smoke: `examples/basic` worker + a five-line script using `@openqueue/sdk/client` against the real port.

## (e) Risks

- **Frozen contract**: everything in `wire.ts` and the route/status/error-code table is `/openqueue/v1` forever once published. Review the wire schemas as the merge gate (explicitly: dates-as-ISO, `{ error: { code, message, issues? } }` envelope, `outcome`-discriminated cancel, 201 for creates, PATCH for schedule update).
- **New core surface is also forever**: `QueueRunsApi.cancel`, `CancelRunResult`, `'cancel'` in `QueueDrainEvent`. The union extension can break downstream *exhaustive* switches over drain events at compile time (in-repo consumers are if-chains — verified safe). `createRunsApi` signature change is internal-ish but exported — note in the PR.
- **Type-parity drift**: client duplicates core's run/schedule types by design; the `conformance.test.ts` mutual-assignability constants are the tripwire — any core type change breaks client `tsc` immediately (good), and turbo's `^build` ordering (client devDeps core) makes that deterministic. Do not "fix" drift by loosening the client types; fix the wire contract deliberately.
- **d.ts self-containment**: if an implementer accidentally imports a core type into a public client module, tsup will either inline core types or emit an `@openqueue/core` import in `dist/*.d.ts` — the step-2 grep check guards this.
- **Fail-open in dev**: unconfigured `api.token` outside production leaves the control API open (eve's placeholder semantics). The boot log line (`auth: open`) is the mitigation; Phase 2's strategy walk replaces this.
- **Cancel semantics**: `executing` runs are not cancelable in Phase 1 (BullMQ can't abort a locked job remotely); `waiting_children`/edge states rely on `job.remove()` throwing → `not_cancelable`. Also `runFromSnapshot` writes best-effort `attempt` values on cancel — acceptable, but say so in the changelog.
- **Release**: repo uses **release-please, not changesets** (commits `95da802`/`e6ca14e` — the CLAUDE.md "Releases" section is stale). Ship as `feat(client)/feat(core)/feat(workbench)/feat(worker)/feat(sdk)` conventional commits; the release-please config/manifest edits above put `@openqueue/client@0.1.4` into the lockstep group so the next release bumps all six to 0.1.5 and `publish.ts` picks it up (first-publish path already handled by the registry-check loop).
- **Workbench dormant tests**: adding the `test` script enrolls four previously-unexecuted test files into CI; if they fail, that's pre-existing debt to surface, not Phase 1 scope.
