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

## Releases (Changesets)

Releases are automated with [Changesets](https://github.com/changesets/changesets).

1. Make your change.
2. Run `bun run changeset`, select the affected packages, pick a bump
   (`patch` / `minor` / `major`), and write a short, user-facing summary.
3. Commit the generated file in `.changeset/` with your PR.

All `@openqueue/*` packages are versioned together, so any release bumps them
all to the same version.

When your PR merges to `main`, the **Release** workflow opens (or updates) a
**"Version Packages"** PR. Merging *that* PR builds the packages and publishes
them to npm.

> Maintainers: publishing requires the `NPM_TOKEN` repository secret and an
> `@openqueue` npm organization that the token can publish to.

## Pull requests

- Keep changes focused; every changed line should trace to the PR's intent.
- Match the surrounding style (Biome enforces formatting and lint).
- Add or update tests when you change behavior.
- Make sure `bun run lint`, `bun run typecheck`, `bun run test`, and
  `bun run build` all pass.

By contributing, you agree that your contributions are licensed under the
project's [MIT license](./LICENSE).
