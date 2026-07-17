# CLAUDE.md

Guidance for Claude Code (and other AI agents) working in this repository.
`AGENTS.md` is a symlink to this file.

## Project Overview

OpenQueue is a batteries-included background job framework for TypeScript, built
on BullMQ and Redis. It's a Bun workspace orchestrated with Turborepo. The
public surface is the `@openqueue/*` packages; the `site` and `examples` are not
published.

## Behavioral Guidelines

These bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think before coding

Don't assume. Don't hide confusion. Surface tradeoffs.

- State assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- Present inconsistencies you notice, with an explanation, without being asked.

### 2. Simplicity first

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked. No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No defensive checks for impossible states — a required field that typing
  guarantees is not a runtime concern. But if something asked for needs error
  handling or validation to work reliably, include it without asking.
- Avoid wrappers for a few lines of code; only wrap when it saves real volume.
- Ask: "would a senior engineer call this overcomplicated?" If yes, simplify.

### 3. Surgical changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken. Match existing style.
- Remove imports/vars/functions *your* change orphaned; leave pre-existing dead
  code (mention it instead of deleting).
- Every changed line should trace to the request.

We don't deprecate, we clean up. We don't comment, we write production code.

### 4. Goal-driven execution

Turn tasks into verifiable goals ("fix the bug" → "write a failing test, make it
pass"). For multi-step work, state a brief plan with a verification per step.
Investigate the root cause; don't shotgun fixes.

## Common Commands

```bash
bun install        # install the workspace
bun run build      # build every package (tsup + Vite) and the site
bun run dev        # watch-build libraries + run the workbench dev server
bun run typecheck  # tsc --noEmit across packages
bun run test       # vitest
bun run lint       # biome check
bun run format     # biome format --write
bun run changeset  # describe a change for release (see Releases below)
```

Per-package work: `cd packages/<pkg> && bun run build|test|typecheck`.

## Architecture

| Package | Name | Runtime | Notes |
| --- | --- | --- | --- |
| `packages/core` | `@openqueue/core` | Node 20.11+ / Bun | Engine: tasks, queues, schedules, flows, Drizzle persistence, OTel hooks — transport-agnostic (no ioredis/bullmq; delivery comes from a world). |
| `packages/openqueue` | `@openqueue/sdk` | Node 20.11+ / Bun | Flagship package; re-exports core. The import users write. |
| `packages/client` | `@openqueue/client` | Node 20.11+ / Bun / edge | Fetch-only HTTP client for a deployed worker; zero Redis/DB deps (only `zod`). |
| `packages/world-bullmq` | `@openqueue/world-bullmq` | Node 20.11+ / Bun | BullMQ world (default delivery): Redis transport + write-through store. Owns ioredis/bullmq; the worker resolves `redis:` config sugar to it. |
| `packages/world-postgres` | `@openqueue/world-postgres` | Node 20.11+ / Bun | Self-migrating Postgres world: `SELECT … FOR UPDATE SKIP LOCKED` transport + Drizzle store, zero Redis. |
| `packages/worker` | `@openqueue/worker` | **Bun only** | Worker app; uses `Bun.serve`, loads config, serves Workbench. |
| `packages/cli` | `@openqueue/cli` | **Bun only** | `openqueue` binary; uses `Bun.build`/`Bun.spawn`/`Bun.Glob`. |
| `packages/workbench` | `@openqueue/workbench` | Node 20.11+ / Bun | Dashboard (React, built by Vite) + h3/Next adapters (built by tsup). |
| `site` | — | — | Docs/marketing (Next.js + Fumadocs). Private. |
| `examples/basic` | — | Bun | A runnable example worker. Private. |

### Build model

Libraries build with `tsup` to ESM + `.d.ts` in `dist/`. The workbench also
builds its React SPA with Vite into `dist/ui` (served from disk via
`UI_DIST_PATH`). Package `exports`/`files` point at `dist`, so what you import in
dev is what npm ships. `workspace:*` inter-deps are rewritten to exact versions
at publish time.

### Package imports

Use the published specifiers, not deep relative paths across packages:

```ts
import { task, defineConfig } from '@openqueue/sdk';
import { createWorker } from '@openqueue/core';
import { buildWorkbenchApp } from '@openqueue/workbench/h3';
```

## Code Style

- **Formatter / linter:** Biome — single quotes, space indentation,
  `noUnusedImports: error`. Run `bun run format` before committing.
- **TypeScript:** strict, `moduleResolution: Bundler`, ESM only.
- The library packages lint clean under the default ruleset. The workbench UI
  relaxes a few rules in `packages/workbench/biome.jsonc` (interactive
  non-semantic elements, `any` at boundaries) — keep new library code strict.
- Verify library docs/APIs with the context7 MCP before introducing a new
  dependency or using unfamiliar methods.
- Read files in full before editing them. Don't get side-tracked by unrelated
  type errors — stay focused on the task.

### Naming

Keep naming concise; avoid double-naming. Use clear, descriptive names.

- `entry`, not `sourceEntry`, when there's no other "entry" to disambiguate.
- Avoid one-trick-pony functions like `updateTaskTitle(id, title)` — make it
  `updateTask` and pass what changed.
- Type information doesn't belong in names: `id` not `idString`, `count` not
  `countNumber`. "Typing" is not a feature — no `apps` vs `typedApps`.
- Avoid React refs where a cleaner approach exists.

### Nesting fields that share a prefix

- When 2+ fields share a prefix that adds no information at the leaf, nest them:
  `buyerCountry, buyerVatId` → `buyer: { country, vatId }`. The heavier the
  shared prefix, the fewer fields it takes to justify nesting.
- A single field never gets a wrapper object.
- For paired optional state, prefer a nullable nested object over two nullable
  fields: `exemption: { code, reason } | null` over `exemptionCode, exemptionReason`.

### Discriminating branches

When a function has 3+ branches a caller may need to discriminate (a retry
decision, an error outcome), expose the branch as a typed field on the return —
not as free-text. Reserve free-text for the debug/audit narrative.

## Releases

Releases use Changesets. Add `bun run changeset` to any PR that should ship a
release; merging to `main` opens a "Version Packages" PR, and merging that
publishes to npm. All `@openqueue/*` packages version in lockstep.

## Misc

- We don't ask the user to run the dev server — they run it themselves.
- We do not use Graphite or PR stacks. Don't suggest them.
- When notifying about changes, mention which packages are affected; for changes
  to shared code, note the downstream packages that depend on it.
