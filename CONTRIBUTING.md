# Contributing to OpenQueue

Thanks for your interest in improving OpenQueue! This document covers local
setup, the day-to-day workflow, and how releases work.

## Prerequisites

- [Bun](https://bun.sh) `>= 1.2` (the repo pins `bun@1.3.13` via `packageManager`)
- A Redis instance for running the worker / integration checks
  (`redis://localhost:6379` is the default everywhere)

## Setup

```bash
git clone https://github.com/quickbits-io/openqueue.git
cd openqueue
bun install
bun run build
```

`bun run build` is worth running once after install: the packages consume each
other's compiled `dist/` output, so a build makes cross-package types resolve.

## Workflow

```bash
bun run dev        # watch-build the libraries + run the workbench dev server
bun run typecheck  # tsc --noEmit across every package
bun run test       # vitest
bun run lint       # biome check
bun run format     # biome format --write
```

All of these are Turborepo tasks, so they run only what changed and cache the
rest.

### Project layout

| Path | Package | Notes |
| --- | --- | --- |
| `packages/core` | `@openqueue/core` | Runtime engine. Node- and Bun-compatible. |
| `packages/openqueue` | `@openqueue/sdk` | Public SDK; re-exports core. |
| `packages/worker` | `@openqueue/worker` | Worker runtime. **Bun-only.** |
| `packages/cli` | `@openqueue/cli` | The `openqueue` binary. **Bun-only.** |
| `packages/workbench` | `@openqueue/workbench` | Dashboard UI (Vite) + Hono/Next adapters (tsup). |
| `site` | — | Docs & marketing site (Next.js + Fumadocs). Not published. |
| `examples/basic` | — | A runnable example worker. Not published. |

### Build model

Each library builds with [`tsup`](https://tsup.egoist.dev) to ESM + `.d.ts` in
`dist/`. The workbench additionally builds its React dashboard with Vite into
`dist/ui` (served from disk by the worker). Package `exports` point at `dist`,
and `files` only ships `dist`, so what you import in development is what users
get from npm.

## Releases (release-please)

Releases are automated with
[release-please](https://github.com/googleapis/release-please). There is no
manual version file to add — release-please reads your commit messages.

1. Write [Conventional Commits](https://www.conventionalcommits.org): `fix:` →
   patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major. Scope by
   package where it helps (`feat(core)!: …`).
2. When your PR merges to `main`, release-please opens (or updates) a
   **release PR** that bumps versions and writes changelogs from those commits.
3. Merging the release PR builds the packages and publishes them to npm
   (`scripts/publish.ts`).

All eight publishable `@openqueue/*` packages — `cli`, `client`, `core`, `sdk`,
`workbench`, `worker`, `world-bullmq`, `world-postgres` — version in **lockstep**
via release-please's `linked-versions` plugin: one `feat!` anywhere lifts the
whole group to the same new version. `bump-minor-pre-major` is deliberately
**unset**, so a breaking commit on a `0.x` line computes `1.0.0` (not `0.2.0`).

`scripts/publish.ts` auto-discovers every non-private `packages/*`, skips
versions already on the registry, and publishes with `bun publish`, which
rewrites `workspace:*` dependencies (e.g. `worker` → `world-bullmq`) to the exact
released version at pack time. Adding a publishable package means adding it to
`release-please-config.json` (component + `linked-versions`) and
`.release-please-manifest.json`; the publish script picks it up automatically.

> **Fallback:** to force a specific version regardless of commit history, set
> `"release-as": "X.Y.Z"` at the top level of `release-please-config.json` for
> one release, then remove it. This is the documented escape hatch if the
> computed version is ever wrong.

> Maintainers: preserve the per-commit `feat!` markers when merging to `main`
> (merge or rebase-merge — a **squash** flattens them and release-please loses
> the signal). Publishing requires the `NPM_TOKEN` repository secret and an
> `@openqueue` npm organization the token can publish to.

## Pull requests

- Keep changes focused; every changed line should trace to the PR's intent.
- Match the surrounding style (Biome enforces formatting and lint).
- Add or update tests when you change behavior.
- Make sure `bun run lint`, `bun run typecheck`, `bun run test`, and
  `bun run build` all pass.

By contributing, you agree that your contributions are licensed under the
project's [MIT license](./LICENSE).
