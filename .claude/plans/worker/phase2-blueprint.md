# Blueprint — Phase 2: Pluggable auth strategies

> Produced by the architect agent. Implementation follows sequencing (d); verify each stage before the next.

## (a) Design summary

**The primitive lives in core as one flat module (`packages/core/src/auth.ts`), faithful to eve's ordered walk.** `AuthStrategy = (request: Request) => Principal | null | undefined | Promise<…>`; first non-null principal wins, `null`/`undefined` skips, typed `UnauthenticatedError`/`ForbiddenError` short-circuit 401/403, exhausted list (including empty) → 401 with `WWW-Authenticate` — fail-closed. Core is the only home that works: `QueueConfig.api.auth` must be typed where `QueueConfig` lives (core), users must import factories from the flagship (`@openqueue/sdk` = `export * from core`), and workbench (walk executor) already depends on core. Workbench-hosted factories would force user configs to import the dashboard package; a client-hosted primitive creates a build cycle (client devDeps core); a new `@openqueue/auth` package is edge-purest but adds a seventh publishable package for ~450 lines — rejected as sprawl, with the module kept import-clean (jose + web standards only, zero core-internal imports) so a Phase 3 `@openqueue/core/auth` subpath carve-out for Workers is a two-line tsup change.

**One deviation from eve, deliberately: the walk returns data, not a `Response`.** Eve's errors embed a prebuilt `Response`; ours carry `{ code, message, challenges }` and `authenticate()` returns a discriminated `AuthResult`. Reason: the `/openqueue/v1` error envelope (`{ error: { code, message } }`) is frozen and differs from eve's, and the dashboard needs a different rendering (text + `Basic realm` challenge) — each surface renders its own denial from the same data.

**JWT/OIDC verification uses `jose` v5 (new core dependency).** jose is zero-runtime-deps, tree-shakeable, and runs Node/Bun/CF Workers/Deno via conditional exports (WebCrypto on edge, node:crypto internally on Node — which is what makes Node 18 work, since Node 18 has no `globalThis.crypto` by default). **jose v6 is rejected: it explicitly drops Node 18** (verified against the v6.0.0 release notes), and core declares `node >=18`. Hand-rolled WebCrypto JWT verification is rejected — alg-confusion, base64url edge cases, and JWKS caching/rotation are exactly the footguns jose exists to remove. Our own code uses zero `node:crypto`: token/password comparison is a pure-JS constant-time XOR loop (in-repo precedent: `workbench/src/server/basic-auth.ts:40`, which documents the accepted length-leak tradeoff). The existing `node:crypto` `timingSafeEqual` in `workbench/src/api/v1/auth.ts` is deleted along with the code it lives in.

**Principal stamping rides in `meta.enqueuedBy` — zero schema migration.** `EnqueueMeta` already has framework-reserved keys with this exact pattern (`parentRunId`, `scheduleId`, `scheduleExternalId`), the `runs`/`schedules` jsonb `meta` columns persist it untouched, the runs `meta` column already has a GIN index, drain events carry it for free inside the snapshot, and schedule ticks inherit `schedule.meta` (`schedules.ts:92`) so schedule-created runs inherit their owner automatically. A dedicated Drizzle column is rejected: users own migrations today, Phase 3's self-migrating worlds are the right moment for a real column/index, and jsonb containment is queryable now. Wire impact is purely additive: `enqueueMetaSchema` is a `looseObject`; we add a typed optional `enqueuedBy` field.

**Ownership is one fixed rule, no new config: a principal with `tenantId` sees only resources stamped with that `tenantId`; a principal without `tenantId` sees everything (today's behavior).** Enforced in the control route handlers: 403 on single-resource access, server-injected deep meta filter on lists. This requires fixing a latent divergence found during research: Postgres filters via `@>` (deep containment) but the Redis-cache path (`state.ts:647 containsMeta`) is shallow `===` — object-valued meta filters silently never match there. We fix it to deep containment (a bug fix that aligns the two stores).

**Also included** (decided yes): the parked QA item — `toRunListOptions`/`toScheduleListOptions` return 400 with issues on invalid query values instead of silently dropping them. Unknown query *keys* stay ignored (forward compat); only present-but-invalid *values* 400.

**Also included** (small): `ClientAuth` gains a `basic` variant so `@openqueue/client` can call a `httpBasic()`-protected API — header-only, no wire change.

## (b) Affected packages

| Package | Change | Downstream |
| --- | --- | --- |
| `@openqueue/core` | `src/auth.ts` (new), `RunPrincipal` + `EnqueueMeta.enqueuedBy`, list-filter `meta` widened to `Record<string, unknown>`, `state.ts` deep containment, `config.ts` `api.auth` + `workbench.auth` union, **new dep `jose@^5`** | Everything; sdk re-exports automatically (`export *`) |
| `@openqueue/client` | Wire types (additive): `runPrincipalSchema`, `enqueueMetaSchema.enqueuedBy`, `WireErrorCode` gains `'forbidden'`. Domain mirrors + list-filter widening (conformance). `ClientAuth` gains `basic` | workbench (schemas), sdk |
| `@openqueue/workbench` | Control API: walk-based auth, principal-aware handlers, stamping, ownership, 400-on-invalid-query. Dashboard: `auth` accepts strategies; `hono/basic-auth` replaced by the walk | worker |
| `@openqueue/worker` | Pass `config.api.{token,auth}` through; log line | — |
| `@openqueue/sdk`, `@openqueue/cli` | untouched (sdk flows via `export *`) | — |
| `e2e` (private) | auth-strategy matrix over real TCP; harness gains `api` param; `jose` devDep | — |

Wire contract: no new routes, no changed shapes — only the additive optional `meta.enqueuedBy`, the additive `'forbidden'` code, and the invalid-query 400 tightening.

## (c) File-level plan

### 1. `@openqueue/core`

**`src/types.ts`** (modify)

```ts
/** Identity slice stamped onto runs/schedules created through the control API
 *  (`meta.enqueuedBy`). Reserved meta key — the API strips inbound values. */
export interface RunPrincipal {
  authenticator: string;   // 'api-key' | 'http-basic' | 'jwt-hmac' | 'oidc' | 'local-dev' | 'none' | custom
  principalId: string;
  /** Well-known: 'service' | 'user' | 'local-dev' | 'anonymous'. Plain string for forward compat. */
  principalType: string;
  tenantId?: string;
}

export interface EnqueueMeta {
  tags?: string[];
  parentRunId?: string;
  scheduleId?: string;
  scheduleExternalId?: string;
  enqueuedBy?: RunPrincipal;            // NEW
  [key: string]: unknown;
}

// In QueueRunListOptions and QueueScheduleListOptions — widen:
  /** Deep-containment filter over `meta` (Postgres `@>` semantics on both stores). */
  meta?: Record<string, unknown>;
```

**`src/auth.ts`** (new, ~450 lines — the eve port). No imports from other core modules except `type { RunPrincipal } from './types'`; runtime imports only `jose` (`jwtVerify`, `createRemoteJWKSet`). Key signatures:

```ts
export interface Principal extends RunPrincipal {
  issuer?: string;
  subject?: string;
  /** Serializable projection of non-standard string claims. NOT stamped onto runs. */
  attributes: Record<string, string | string[]>;
}

export type AuthStrategy = (
  request: Request,
) => Principal | null | undefined | Promise<Principal | null | undefined>;

export interface AuthChallenge {
  scheme: 'Basic' | 'Bearer';
  parameters?: Record<string, string>;
}
export interface AuthDenialOptions { code?: string; message?: string; challenges?: AuthChallenge[] }

export class UnauthenticatedError extends Error {  // status 401
  readonly code: string;                            // default 'unauthorized'
  readonly challenges: AuthChallenge[];
  constructor(options?: AuthDenialOptions);
}
export class ForbiddenError extends Error {         // status 403
  readonly code: string;                            // default 'forbidden'
  constructor(options?: Omit<AuthDenialOptions, 'challenges'>);
}

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; code: string; message: string; challenges: AuthChallenge[] };

/** Ordered walk: first Principal wins; null/undefined skips; Unauthenticated/
 *  ForbiddenError short-circuit; exhausted (incl. empty array) → 401 with
 *  `options.challenges` (default [{ scheme: 'Bearer' }]). Non-auth throws propagate. */
export async function authenticate(
  request: Request,
  strategies: AuthStrategy | readonly AuthStrategy[],
  options?: { challenges?: AuthChallenge[] },
): Promise<AuthResult>;

// ---- strategies: pure verifier + thin wrapper each ----

export function extractBearerToken(header: string | null): string | null;
export type VerifyResult = { ok: true; principal: Principal } | { ok: false };

export interface ApiKeyOptions {
  token: string | readonly string[];
  /** Defaults: { principalId: 'api-key', principalType: 'service' }. Distinct
   *  keys per tenant = multiple apiKey() entries in the walk. */
  principal?: { principalId?: string; principalType?: string; tenantId?: string };
}
export function apiKey(options: string | readonly string[] | ApiKeyOptions): AuthStrategy;
export function verifyApiKey(header: string | null, options: ApiKeyOptions): VerifyResult;
// compare: constant-time XOR loop, early return on length mismatch (basic-auth.ts precedent)

export interface HttpBasicOptions { username: string; password: string; tenantId?: string }
export function httpBasic(options: HttpBasicOptions): AuthStrategy;
export function verifyHttpBasic(header: string | null, options: HttpBasicOptions): VerifyResult;
// principal: { authenticator: 'http-basic', principalId: username, principalType: 'user' }

export interface JwtClaimMatchers {
  /** AWS IAM-style `*` whole-string wildcards against `sub`. */
  subjects?: readonly string[];
  /** Each named claim must contain at least one listed value. */
  claims?: Readonly<Record<string, readonly string[]>>;
}
export interface JwtHmacOptions extends JwtClaimMatchers {
  algorithm: 'HS256' | 'HS384' | 'HS512';
  secret: string;
  issuer: string;
  audience: string | readonly string[];
  clockSkewSeconds?: number;              // default 30
  /** Claim read into principal.tenantId (e.g. 'org_id'). String claims only. */
  tenantClaim?: string;
}
export function jwtHmac(options: JwtHmacOptions): AuthStrategy;
export function verifyJwtHmac(token: string | null, options: JwtHmacOptions): Promise<VerifyResult>;
// jose: jwtVerify(token, new TextEncoder().encode(secret), { algorithms, issuer, audience, clockTolerance })
// reject empty/missing sub; apply matchers; principalId = `${iss}:${sub}`; principalType 'service';
// attributes = non-standard string claims (port eve's token-claims.ts projection + wildcard matcher, minus Vercel paths)

export interface OidcOptions extends JwtClaimMatchers {
  issuer: string;
  audience: string | readonly string[];
  /** Defaults to `${issuer}/.well-known/openid-configuration` (trailing slash stripped). */
  discoveryUrl?: string;
  clockSkewSeconds?: number;
  tenantClaim?: string;
}
export function oidc(options: OidcOptions): AuthStrategy;
export function verifyOidc(token: string | null, options: OidcOptions): Promise<VerifyResult>;
// discovery doc fetched once + cached in the strategy closure (delete cache entry on failure,
// console.warn the failure, return { ok: false } so the walk continues — eve's 'misconfigured' → skip);
// createRemoteJWKSet(new URL(jwks_uri)) cached per closure; verification as jwtHmac.

export function localDev(): AuthStrategy;
// Port eve's loopback check minus VERCEL env special-casing: URL hostname is
// 'localhost' | '[::1]' | 127.0.0.0/8 | '*.localhost' → { authenticator: 'local-dev',
// principalId: 'local-dev', principalType: 'local-dev' }; else null.
// tsdoc caveat: trusts the Host header — spoofable when not behind a proxy that sets it.
export function isLoopbackRequest(request: Request): boolean;

export function none(): AuthStrategy;
// → { authenticator: 'none', principalId: 'anonymous', principalType: 'anonymous', attributes: {} }
```

No exported `placeholderAuth()` — unconfigured⇒open-dev/locked-prod stays in the workbench resolver. No `jwtEcdsa` (out of scope; `oidc` covers asymmetric via JWKS).

**`src/state.ts`** (modify) — `containsMeta` becomes deep containment matching Postgres `@>`: objects recurse (narrowing via an `isRecord` type predicate — no casts), arrays match when every expected element is contained in some actual element, scalars `===`. Signature: `containsMeta(meta: EnqueueMeta, filter: Record<string, unknown>): boolean`. Covers both call sites (schedules ~:300, runs ~:430).

**`src/config.ts`** (modify)

```ts
import type { AuthStrategy } from './auth';

  workbench?: {
    // ...existing...
    /** Basic credentials (sugar for [httpBasic(...)]) or an ordered AuthStrategy walk.
     *  Unset = dashboard open (existing behavior). */
    auth?: { username: string; password: string } | AuthStrategy[];
  };
  api?: {
    /** Bearer token(s) — sugar for a leading apiKey() strategy. */
    token?: string | string[];
    /** Ordered strategy walk for /openqueue/v1. Empty array = always 401 (fail-closed).
     *  With `token` also set, the token check runs first. Neither set: open in dev,
     *  locked when NODE_ENV=production. */
    auth?: AuthStrategy[];
  };
```

**`src/drizzle.ts`** — no schema change; `metaContains` already deep. Verify only.

**`src/index.ts`** (modify) — export from `./auth`: `authenticate`, `apiKey`, `httpBasic`, `jwtHmac`, `oidc`, `localDev`, `none`, `extractBearerToken`, `isLoopbackRequest`, `verifyApiKey`, `verifyHttpBasic`, `verifyJwtHmac`, `verifyOidc`, `UnauthenticatedError`, `ForbiddenError`, + types `Principal`, `AuthStrategy`, `AuthResult`, `AuthChallenge`, `AuthDenialOptions`, `VerifyResult`, `ApiKeyOptions`, `HttpBasicOptions`, `JwtHmacOptions`, `OidcOptions`, `JwtClaimMatchers`; add `RunPrincipal` to the types block.

**`package.json`** — add `"jose": "^5.9.6"` (NOT v6 — Node 18) to `dependencies`.

**Tests** — `src/__tests__/auth.test.ts`: walk matrix (first-wins, skip-on-null, empty → 401 + Bearer challenge, error mapping incl. custom code/message/challenges, non-auth error propagation, custom exhausted challenges); verifiers pure (apiKey match/mismatch/multi-token/scheme case/principal overrides; httpBasic parse/reject matrix; wildcard subject + claims matchers; jwtHmac sign-with-jose then verify: happy/expired/wrong issuer/audience/alg/missing sub/tenantClaim; localDev hostname matrix incl. `[::1]`, `127.0.0.5`, `foo.localhost`, reject `0.0.0.0` + public hosts; none()). `src/__tests__/auth-oidc.test.ts`: `node:http` server serving discovery + JWKS (jose `generateKeyPair` RS256), accept/reject/discovery-failure-skips. State tests: deep `containsMeta` incl. `{ enqueuedBy: { tenantId } }` partial match.

### 2. `@openqueue/client`

**`src/wire.ts`** (additive only)

```ts
export const runPrincipalSchema = z.object({
  authenticator: z.string(),
  principalId: z.string(),
  principalType: z.string(),
  tenantId: z.string().optional(),
});
export type WireRunPrincipal = z.infer<typeof runPrincipalSchema>;

export const enqueueMetaSchema = z.looseObject({
  // ...existing fields...
  enqueuedBy: runPrincipalSchema.optional(),   // NEW
});

export type WireErrorCode = /* existing */ | 'forbidden';   // NEW (schema stays plain string)
```

**`src/types.ts`** — mirror core exactly (conformance): `RunPrincipal`, `EnqueueMeta.enqueuedBy?`, widen list-option `meta` to `Record<string, unknown>`.

**`src/http.ts` + `src/index.ts`**

```ts
export type ClientAuth =
  | { bearer: TokenValue }
  | { basic: { username: string; password: string } };
// bearer → `Bearer ${await resolve()}`; basic → `Basic ${btoa(`${u}:${p}`)}`
```

403 already maps to `'forbidden'`. **Tests**: basic-auth header emission; meta.enqueuedBy round-trip through `wireRunSchema`; conformance recompile against new core types.

### 3. `@openqueue/workbench`

**`src/api/handlers.ts`** — additive optional field:

```ts
export interface HandlerInput {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body?: unknown;
  /** Verified caller, when the mounting app ran an auth walk. */
  principal?: Principal;                 // import type { Principal } from '@openqueue/core'
}
```

**`src/api/v1/auth.ts`** (rewrite — deletes all `node:crypto` usage)

```ts
import { apiKey, authenticate, type AuthChallenge, type AuthStrategy, type Principal } from '@openqueue/core';

export interface ControlAuthConfig {
  token?: string | string[];
  strategies?: readonly AuthStrategy[];
}
export type ControlAuth =
  | { mode: 'strategies'; strategies: readonly AuthStrategy[] }
  | { mode: 'open' }
  | { mode: 'locked' };

/** token → leading apiKey(); strategies (even []) → walk; neither → open (dev) / locked (prod). */
export function resolveControlAuth(config: ControlAuthConfig | undefined, nodeEnv: string | undefined): ControlAuth;

export type ControlAuthDecision =
  | { ok: true; principal?: Principal }        // principal absent only in 'open' mode
  | { ok: false; status: 401 | 403; code: string; message: string; challenges: AuthChallenge[] };

export async function authorizeControlRequest(auth: ControlAuth, request: Request): Promise<ControlAuthDecision>;
// locked message MUST keep containing 'api.token' (e2e asserts it):
// 'Control API is locked: set api.token or api.auth to enable access in production'
```

**`src/api/v1/principal.ts`** (new — pure)

```ts
import type { EnqueueMeta, Principal, RunPrincipal } from '@openqueue/core';

export function toRunPrincipal(principal: Principal): RunPrincipal;   // 4 fields — attributes/issuer/subject NOT stamped
/** Strips any inbound `enqueuedBy` (reserved, anti-spoof), stamps the verified principal when present. */
export function stampMeta(meta: EnqueueMeta | undefined, principal: Principal | undefined): EnqueueMeta | undefined;
/** No tenantId on caller → full access; tenantId → owner stamp must match. Unowned resources denied to tenant-scoped callers. */
export function canAccess(principal: Principal | undefined, resourceMeta: EnqueueMeta): boolean;
/** Injects/merges { enqueuedBy: { tenantId } } into a deep meta filter when tenant-scoped (caller cannot widen). */
export function scopeMetaFilter(principal: Principal | undefined, meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined;
```

**`src/api/v1/serialize.ts`** — 400-on-invalid-query:

```ts
export type QueryParse<T> = { ok: true; options: T } | { ok: false; issues: { path: string; message: string }[] };
export function toRunListOptions(query: Record<string, string | undefined>): QueryParse<QueueRunListOptions>;
export function toScheduleListOptions(query: Record<string, string | undefined>): QueryParse<QueueScheduleListOptions>;
```

Present-but-invalid values → issues (status enum; sort `field:direction`; meta JSON + schema; start/end parseable + both present; limit positive int; active boolean). Unknown keys ignored. Handlers map `!ok` → `controlError('invalid_request', 'Invalid query', issues)`. `statusForCode` gains `'forbidden' → 403`.

**`src/api/v1/routes.ts`** — `ControlApiOptions.auth: ControlAuthConfig`. Handler changes (all read `input.principal`): `POST /jobs` + `POST /schedules` stamp meta; `PATCH /schedules/:id` retrieve-first → `canAccess` else 403; body meta strips inbound `enqueuedBy` and re-attaches the ORIGINAL stamp (owner immutable); `GET /runs/:id` + `POST /runs/:id/cancel` + schedule by-id routes: retrieve → 404 → `canAccess` else 403 (no detail leak); lists: parse query (`!ok` → 400) then `scopeMetaFilter`; `/health` `/info` `/catalog` unchanged.

**`src/api/v1/app.ts`** — `type ControlEnv = { Variables: { principal?: Principal } }`; health first; middleware: `authorizeControlRequest(auth, c.req.raw)`; on failure append one `WWW-Authenticate` per challenge (formatter ported from eve's `formatChallenge`; default `Bearer` preserved), body via `controlError`, log line `console.warn('[openqueue] control API auth failed (401) GET /runs — unauthorized')` (method+path+status+code; never headers/tokens). On success `c.set('principal', …)`; `dispatch` passes principal into `HandlerInput`. NODE_ENV still sampled at construction (e2e harness depends on it).

**Dashboard** — `src/core/types.ts`: `WorkbenchOptions.auth?: { username: string; password: string } | AuthStrategy[]`. `src/core/workbench.ts`: `requiresAuth()` — object form `!!(username && password)`; array form always `true` (fail-closed incl. empty). New `src/server/auth-middleware.ts`:

```ts
/** Normalizes WorkbenchOptions.auth into a walk → Hono middleware, or undefined when off.
 *  Credentials sugar → [httpBasic(credentials)] with exhausted-challenge `Basic realm="Workbench"`
 *  (browser prompt parity); failure body: 401 text 'Unauthorized'. */
export function workbenchAuthMiddleware(auth: WorkbenchOptions['auth']): MiddlewareHandler | undefined;
```

`src/server/hono-app.ts` + `hono-api-app.ts`: replace `basicAuth({...})` blocks (removing their non-null assertions) with the middleware. Covers `createFetchHandler` + Next adapter automatically. `checkBasicAuth`/`BASIC_AUTH_CHALLENGE` exports stay (published surface).

**`src/index.ts`** — exports same names; `ControlAuth`/`resolveControlAuth` reshape (unreleased Phase 1 surface — allowed).

**Tests** — rewrite `api/v1/__tests__/auth.test.ts` (mode resolution incl. empty-array strategies; walk decisions on `Request`; locked message contains `'api.token'`). Extend `routes.test.ts`: stamp on trigger; spoof stripped; tenant 403 matrix; list scoping (caller can't widen); PATCH preserves original stamp; `?status=typo`/`?sort=bogus`/`?meta={`/lone `?start=` → 400 with issues. New `principal.test.ts` (pure helpers) + `server/__tests__/auth-middleware.test.ts` (sugar accept/reject + realm challenge; array walk; undefined → none).

### 4. `@openqueue/worker`

`src/index.ts` — pass-through:

```ts
const controlAuth = resolveControlAuth(
  config.api && { token: config.api.token, strategies: config.api.auth },
  process.env.NODE_ENV,
);
health.route('/openqueue/v1', buildControlApp({
  runtime,
  auth: { token: config.api?.token, strategies: config.api?.auth },
  info: { namespace: config.namespace },
}));
console.log(`[openqueue] control API mounted at /openqueue/v1 (auth: ${controlAuth.mode})`);
```

`workbench.auth` flows into `WorkbenchCore` unchanged (union widens end-to-end). `config-validation.test.ts` untouched.

### 5. `e2e`

**`src/harness.ts`** — `startTestWorker(options: { token?: string | false; api?: QueueConfig['api']; workbench?: QueueConfig['workbench'] })`; `api` wins over token shorthand. **`package.json`** — `jose` devDep.

**`src/__tests__/auth-strategies.test.ts`** (new):
1. Two-tenant apiKey worker: t1 triggers → run stamped `{ authenticator: 'api-key', …, tenantId: 't1' }`; t2 retrieve/cancel t1's run → `forbidden`; lists scoped both ways; schedule ownership same; client-sent spoof overwritten.
2. Ordered walk `[httpBasic, apiKey]`: basic client (new `ClientAuth.basic`) accepted; bearer accepted; garbage → 401 + `WWW-Authenticate` Bearer.
3. `api.auth: []` → 401 everything except `/health`.
4. `api.token` + `api.auth` combined — token client works.
5. jwtHmac with `tenantClaim: 'org'`: jose-minted valid accepted + stamped; expired/wrong-issuer → 401.
6. `GET /runs?status=typo` over TCP → 400 `invalid_request` with issues.

Existing e2e `auth.test.ts` (token/open/locked) must pass **unchanged**. `oidc()` covered by core unit tests only (no IdP in compose).

## (d) Sequencing

1. **Core** — auth.ts + jose + types + state deep-containment + config + index + tests. Verify: `cd packages/core && bun run test && bun run typecheck && bun run build`; root `bun install`.
2. **Client** — wire + mirrors + ClientAuth.basic + tests. Verify: build/typecheck/test; conformance green; dist greps (`@openqueue/core` absent from d.ts; `jose|ioredis|bullmq|drizzle` absent from dist js — **jose must not leak into client**).
3. **Workbench** — handlers field, v1 rewrite, dashboard middleware, tests. Verify: build/typecheck/test (+ extend Redis-gated control-integration with one stamped-run + one 403 assertion).
4. **Worker** — pass-through + log. Verify per package, then root build/typecheck/test.
5. **E2E** — harness + auth-strategies matrix. Verify: compose up + full `bun run e2e` (on this machine: `REDIS_URL=redis://localhost:6380 DATABASE_URL=postgres://openqueue:openqueue@localhost:5434/openqueue`); pre-existing e2e green unchanged.

Conventional commits: `feat(core)`, `feat(client)`, `feat(workbench)`, `feat(worker)`, `test(e2e)`.

## (e) Risks

- **Forever surface (core)**: `authenticate`, six factories, verifiers, `Principal`/`RunPrincipal`/`AuthResult`, `meta.enqueuedBy` reserved key. Merge-gate review. `principalType: string` deliberate (forward compat).
- **jose pinned v5**: v6 needs Node ≥20; upgrade blocked on dropping Node 18 (EOL — separate decision; note in PR). v5 is zero-dep.
- **Edge**: `core/src/auth.ts` import-clean (jose + web standards) — Phase 3 `./auth` subpath carve-out trivial later; deliberately not added now.
- **Deliberate behavior changes (changelog)**: (1) invalid list-query values → 400; (2) Redis-path meta filters now deep-match (bug fix, aligns with Postgres); (3) locked message gains "or api.auth" (still contains `api.token`).
- **Tenancy**: no-tenantId = super-principal (today's behavior); tenant-scoped callers can't see unowned/pre-Phase-2 resources (fail-closed). Direct-SDK users can write `meta.enqueuedBy` themselves — same trust class as `scheduleId`; documented reserved.
- **No DB migration** — jsonb `meta` (GIN-indexed on runs). Dedicated column arrives with Phase 3 worlds.
- **Unreleased-surface reshape**: `resolveControlAuth`/`ControlAuth`/`ControlApiOptions.auth` — Phase 1 additions on the same uncommitted branch; workbench `api/v1/__tests__/auth.test.ts` is the only test file with legitimate assertion changes; e2e auth suite passes unchanged.
- **Dashboard**: unconfigured = open in production (pre-existing contract, unchanged — known gap, not Phase 2 scope); credentials sugar keeps exact `Basic realm="Workbench"` behavior; `localDev()` Host-header caveat in tsdoc.
- **OIDC discovery failure** → walk-skip + `console.warn` (fail-closed; warn is the mitigation).

Eve reference: `.context/eve/packages/eve/src/public/channels/auth.ts`, `.context/eve/packages/eve/src/runtime/governance/auth/{jwt-hmac,oidc,http-basic,token-claims}.ts`.
