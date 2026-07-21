# Blueprint — Hono → h3 migration (dispatch/mounting shell only)

> Architect blueprint, verified against registry.npmjs.org + h3.dev + h3js/h3 source (context7 unavailable that session). Single backend workstream. The RouteDef table, handlers, serializers, auth walk, wire schemas, and /openqueue/v1 contract are UNTOUCHED.

## h3 verification results (2026-07-17)

- Versions: `latest → 2.0.1-rc.25`, `beta → 2.0.0-beta.5`, `1x → 1.15.11`. No stable 2.0.0, but `latest` IS the RC line. **Decision: adopt v2, EXACT pin `2.0.1-rc.25`** (no ^; RC bumps are deliberate + re-run e2e harness; take stable 2.0.0 if shipped by implementation time).
- Deps: `rou3 ^0.9.1` (router) + `srvx ^0.11.22` (server/adapters); optional peer `crossws` (do NOT install — no WS usage).
- **Engines: node >= 20.11.1 — workbench must bump from >=18** (maintainer sign-off; Node 18 EOL'd 2025-04, Node 20 EOL'd 2026-04; core/sdk/client stay 18+, worker/cli Bun-only).
- API: `new H3()`; fetch-native `event.req: Request`, `event.url: URL`, `event.res.headers`; `app.on(method, path, handler)` (lowercase methods accepted — our HttpMethod union passes cast-free); params at `event.context.params`; body `event.req.json()`.
- `app.fetch(req)`; **`app.request(path|URL|Request, init?)` — verbatim Hono-compatible test signature.**
- Middleware `app.use(mw)` / `app.use('/path/**', mw)`, `(event, next)`; Response return short-circuits. **Verified from src/h3.ts: global middleware runs BEFORE route lookup AND on unmatched paths (404 fallback only after middleware)** — fail-closed has real footing.
- `H3.mount(base, subApp)`: routes merged as base+route; sub-app global middleware wrapped in a base-boundary check that STRIPS base from event.url.pathname during sub-app middleware (restores after). Bare base path covered. Plain fetch handlers: `all('${base}/**')` + prefix strip.
- 404: `HTTPError` JSON `{"status":404,"message":"Cannot find any route matching …"}` (differs from Hono's text — parity note below).
- Handler-returned `Response` passes through AS-IS when no prepared headers set — hand-built WWW-Authenticate responses survive byte-for-byte.
- Node adapter: `toNodeHandler(app)` (srvx-backed; v1's toNodeListener renamed) — **the Express story, first-class**.

## Design summary

Swap only the shell: `Hono` → `new H3()`, `.route(prefix, app)` → `.mount(prefix, app)`, Hono middleware → h3 middleware. Three deliberate deviations from mechanical translation:

1. **Health-first ordering doesn't port** (h3 middleware always precedes routes): the control auth middleware gains an explicit `event.url.pathname === '/health'` bypass — safe under mount (verified base-strip). Fail-closed then comes from h3's architecture itself; NEW tripwire test: unauthenticated request to an UNKNOWN path under the control app → 401, standalone AND mounted.
2. **OpenAPI goes framework-free**: replace `@hono/zod-openapi` + `@scalar/hono-api-reference` with self-generation from the RouteDef table using zod v4 `z.toJSONSchema()` (OpenAPI 3.1 = JSON Schema 2020-12). `/reference` = self-rendered Scalar HTML shell (~15 lines, preserve `scalarCdn` option). Replicate zod-openapi's pre-handler validation in dashboard-API dispatch: params→query→body, first failure → 400 `{error:'Invalid request', issues:[{path,message}]}` (identical envelope).
3. **CORS hand-rolled** (~20 lines): current usage is `hono/cors` defaults (`*`). Byte-parity gate against baseline snapshots.

Principal passing: closure-scoped `WeakMap<H3Event, Principal>` between auth middleware and dispatch (no event.context module augmentation — a published lib must not; no `any`).

## Affected packages

workbench (main site: router, both server apps, control app, auth middleware, entry rename `./hono` → `./h3`, deps, engines), worker (health.ts + index.ts mounting, dep), e2e (control-plane.ts construction, dep; ZERO assertion changes). core/sdk/client/cli UNTOUCHED (verified: core/auth.ts is framework-free web-Request; client fetch-only; cli no hono). Docs: two-plane.mdx, workbench.mdx, index.mdx, workbench README, CLAUDE.md.

## File-level plan

### packages/workbench
- **NEW `src/api/openapi.ts`** (pure, zero framework imports): `buildOpenApiDocument(routes: readonly RouteDef[], info): OpenApiDocument` — port `toOpenApiPath` (`:param`→`{param}`); params/query from `meta.params.shape`/`meta.query.shape` with `required = !prop.safeParse(undefined).success`, `schema = z.toJSONSchema(prop)`; responses from `meta.status ?? 200` + `meta.response` + shared 400 with errorResponseSchema (mirroring today's routeConfig). Routes without meta omitted (same as today).
- **REWRITE `src/api/router.ts`** — drops @hono/zod-openapi + scalar + hono. `createApiRoutes(core): H3`; per-RouteDef `app.on(method, path, e => dispatch(route, e))`; dispatch builds HandlerInput from `event.context.params ?? {}`, `Object.fromEntries(event.url.searchParams)`, `event.req.json().catch(() => undefined)`; for meta routes validate params→query→body BEFORE handler → 400 envelope on first failure; `GET /openapi.json` → buildOpenApiDocument (same info block); `GET /reference` → Scalar HTML shell (`data-url="openapi.json"`, scalarCdn default jsdelivr; match @scalar/hono-api-reference's bootstrap pattern for functional parity).
- **REWRITE shell of `src/api/v1/app.ts`** — `buildControlApp(options): H3`: middleware = health-bypass + authorizeControlRequest + warn log + authFailureResponse (identical Headers.append WWW-Authenticate + JSON envelope) + `principals.set(event, principal)`; route loop `app.on(...)` with `dispatch(route, event, principals.get(event))`; /health keeps ordinary route registration (middleware bypass replaces the registration-order skip); formatChallenge/escapeChallengeValue verbatim.
- **MOD `src/server/auth-middleware.ts`** — same logic; Hono MiddlewareHandler → h3 Middleware type; `authenticate(event.req, ...)`; hand-built 401/403 Response; success `return next()`.
- **NEW `src/server/cors.ts`** (~20 lines): non-OPTIONS → set `Access-Control-Allow-Origin: *` on event.res.headers then next() (h3 merges prepared headers); OPTIONS → 204 with `*` + `GET,HEAD,PUT,POST,DELETE,PATCH` + echo Access-Control-Request-Headers.
- **RENAME `src/server/hono-app.ts` → `h3-app.ts`** — `buildWorkbenchApp(core): H3`: `app.use('/api/**', cors)`; auth middleware; `app.mount('/api', createApiRoutes(core))`; /config, /assets/:file, /app-icon.svg, `/**` catch-all (explicit Response, `text/html; charset=UTF-8`). **MUST-VERIFY: rou3 `/**` matching the app root** (`/` and bare basePath under mount) — mandatory unit test; fallback = explicit `/` alias route.
- **RENAME `src/server/hono-api-app.ts` → `h3-api-app.ts`** — same translation (cors on /api/** AND /config as today).
- **RENAME `src/hono.ts` → `src/h3.ts`** — same exports, H3-typed; docstring: quarantines h3 types (neutral surface stays `createFetchHandler` on main entry). **Naming decision: `./h3`** (the entry returns framework types — a neutral name would hide the h3 requirement).
- `src/api/fetch-handler.ts` — import path update only. **`src/next.ts` — ZERO changes** (consumes createFetchHandler only, verified). `src/control.ts` — docstring only if it mentions Hono.
- **package.json** — remove hono/@hono/zod-openapi/@scalar/hono-api-reference; add `"h3": "2.0.1-rc.25"` EXACT; exports `./hono` → `./h3`; `engines.node: ">=20.11.1"`; keywords. **tsup.config.ts** — entry rename.
- **Tests**: auth-middleware.test.ts (`new H3()` + `app.use(mw)`; app.request unchanged); routes.test.ts (no construction change); control-integration.test.ts (`.route` → `.mount`); NEW: fail-closed-before-404 tripwire (standalone + mounted), bare-mount-path serves index, buildOpenApiDocument structural snapshot (path+method+params+statuses).

### packages/worker
- `src/health.ts` — `new H3()`; Response.json for /health, /ready (503 when not ready); /metrics explicit `text/plain; charset=UTF-8`.
- `src/index.ts` — import from `@openqueue/workbench/h3`; `.route(` → `.mount(`; `Bun.serve({ fetch: (req) => health.fetch(req) })` (arrow-wrap unless .fetch verified bound). package.json: hono → h3 exact pin.

### e2e
- `src/control-plane.ts` — `new H3()` + `.mount(...)` + Bun.serve arrow. package.json hono → h3. **All test files: ZERO changes** (they speak HTTP over TCP).

### Docs
- CLAUDE.md: import example → `@openqueue/workbench/h3`; workbench row "h3/Next adapters"; workbench runtime Node 20.11+ (others stay 18+).
- two-plane.mdx: `const app = new H3(); app.mount('/openqueue/v1', buildControlApp(...)); export default app;`.
- workbench.mdx: h3 mounting + TWO recipes — Hono users: `honoApp.mount('/admin/jobs', createFetchHandler({...basePath}).fetch)`; **Express (the original motivation): `expressApp.use('/admin/jobs', toNodeHandler(app))`** (verify exact import specifier: 'h3' node condition vs 'h3/node'). Docs-only, no shipped helper — h3's adapter IS the helper.
- index.mdx: "mountable into any fetch-native host (h3, Hono, Elysia) / Next.js". Workbench README: table row.

## Sequencing
1. **Baseline capture** (before dep changes): three e2e suites green on Hono; dump /openapi.json + header snapshots (CORS, charsets, 404s, WWW-Authenticate) to scratchpad.
2. buildOpenApiDocument + structural test against live zod-openapi output (temporary comparison test → becomes standing snapshot).
3. Workbench shell swap + entry rename + deps. Verify: typecheck/vitest/build + bundle gates rerun (esp. ./control browser-target: h3's browser condition must keep srvx's node:http out; also confirm NO hono specifiers survive in any dist).
4. Worker + e2e harness swap. Verify: worker vitest/typecheck; **ALL THREE e2e suites green with ZERO assertion changes — the primary gate**.
5. Docs; openapi.json before/after diff review (structural invariants, not bytes).
6. Commit: `feat(workbench)!:` (see risks — ./hono WAS published in 0.1.x) + feat(worker), test:, docs:.

## Wire-parity spot-checks (QA list)
1. WWW-Authenticate single + multi-challenge (e2e covers).
2. Unknown-path 404 with valid auth: body changes Hono text → h3 JSON HTTPError. No assertion touches it (grep-verified); spot-check client error handling; optional later polish = `/**` fallback with controlError('not_found') envelope (NOT in this migration).
3. Dashboard 400 validation envelope byte-compare (invalid body/query/param; order params→query→body).
4. CORS headers GET + OPTIONS preflight vs baseline snapshot (byte-identical bar).
5. Content-Type charsets: /config, catch-all HTML, /metrics, assets-404 vs baseline.
6. Duplicate query keys: fromEntries last-wins vs Hono — no producer sends dupes (client meta = one JSON param); unasserted edge, note only.
7. Path-param percent-decoding probe (encoded ids) rou3 vs Hono.
8. /health/ trailing slash + HEAD status-only comparison.
9. Mounted auth-warn logs stripped path — log-only, accepted.

## Risks
- **Node 20.11.1 floor for workbench** (engines bump; release note; Next-adapter users on old Node affected; CI unaffected).
- **RC pin**: exact `2.0.1-rc.25`; re-check for stable at implementation; bumps re-run e2e harness.
- **`./hono` already published in 0.1.x** → rename is BREAKING (`feat(workbench)!:`) with migration line (./hono → ./h3; Hono users → createFetchHandler + Hono's own mount). Pre-1.0 acceptable, not free — correction to the "free rename" premise (only v1/control surfaces are unreleased).
- **Bundle gates are the arbiter**: if h3's browser condition leaks node:http into ./control, ESCALATE (h3 `./generic` entry is the fallback — a design amendment, not a workaround to apply silently).
- **rou3 `/**` root-matching**: the one unverified routing behavior — mandatory unit test + specified fallback.
- OpenAPI not byte-identical — structural-invariant gate + one human-reviewed diff. Generator becoming framework-free is a durable win.
- Release notes accumulate: h3 shell, ./hono → ./h3, Node 20.11+ workbench floor, removed zod-openapi/Scalar deps.
