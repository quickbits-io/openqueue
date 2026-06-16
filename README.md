# OpenQueue

[![CI](https://github.com/quickbits-io/openqueue/actions/workflows/ci.yml/badge.svg)](https://github.com/quickbits-io/openqueue/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@openqueue/sdk.svg)](https://www.npmjs.com/package/@openqueue/sdk)
[![license](https://img.shields.io/npm/l/@openqueue/sdk.svg)](./LICENSE)

A batteries-included background job framework for TypeScript, built on
[BullMQ](https://bullmq.io) and Redis. You define tasks as plain functions with
a [Zod](https://zod.dev) schema; OpenQueue handles queues, workers, validation,
retries, scheduling, flows, and observability — and ships a real dashboard
(**Workbench**) inside your worker.

```ts
import { task } from '@openqueue/sdk';
import { z } from 'zod';

export const sendWelcome = task({
  id: 'send-welcome',
  schema: z.object({ email: z.string().email() }),
  run: async (payload, ctx) => {
    ctx.logger.info('sending welcome email', { email: payload.email });
    return { ok: true };
  },
});

// anywhere in your app
await sendWelcome.trigger({ email: 'alex@example.com' });
```

## Why OpenQueue

- **No new infrastructure.** Runs on the Redis you already have. Run history can
  persist to the Postgres you already have, via Drizzle.
- **Typed end to end.** The Zod schema validates payloads at trigger time and
  types them inside `run`.
- **Operations included.** Workbench gives you live counters, run inspection,
  retry-from-the-UI, flow graphs, schedules, error triage, and a test console —
  without building an admin page.
- **Boring failure semantics.** Three attempts with exponential backoff by
  default; a small error taxonomy (`RetryableError`, `NonRetryableError`,
  timeouts, TTLs) when you need control.

## Quickstart

You need a Redis URL and [Bun](https://bun.sh).

```bash
bun add @openqueue/sdk
bun add -d @openqueue/cli
bunx openqueue init
```

`init` scaffolds `worker.config.ts`, a starter task, env files, and a
Dockerfile, then run:

```bash
bunx openqueue dev
```

See the [full quickstart](./site/content/docs/quickstart.mdx) and the rest of
the docs under [`site/content/docs`](./site/content/docs).

## Packages

| Package | Description |
| --- | --- |
| [`@openqueue/sdk`](./packages/openqueue) | The main entry — `task()`, `defineConfig()`, `enqueueFlow()`, errors, adapters. |
| [`@openqueue/core`](./packages/core) | The underlying runtime (re-exported by `@openqueue/sdk`). |
| [`@openqueue/worker`](./packages/worker) | The worker app — loads your config, runs tasks, serves Workbench. |
| [`@openqueue/workbench`](./packages/workbench) | The dashboard — standalone or mountable into Hono / Next.js. |
| [`@openqueue/cli`](./packages/cli) | The `openqueue` CLI — `init`, `dev`, `build`, `start`. |

> **Runtime note:** `@openqueue/core`, `@openqueue/sdk`, and `@openqueue/workbench`
> run on Node 18+ or Bun. `@openqueue/worker` and `@openqueue/cli` are
> **Bun-native** (they use Bun's bundler, process, and HTTP server APIs).

## Repository layout

This is a [Bun](https://bun.sh) workspace orchestrated with
[Turborepo](https://turbo.build):

```
packages/
  core/        @openqueue/core      — runtime engine
  openqueue/   @openqueue/sdk       — public SDK (flagship package)
  worker/      @openqueue/worker    — worker runtime
  cli/         @openqueue/cli       — the `openqueue` binary
  workbench/   @openqueue/workbench — dashboard UI + server adapters
site/          docs & marketing site (Next.js + Fumadocs)
examples/
  basic/       a minimal worker you can run end to end
```

### Common commands

```bash
bun install        # install everything
bun run build      # build all packages (tsup + Vite) and the site
bun run dev        # watch-build libraries / run the workbench dev server
bun run typecheck  # tsc --noEmit across the workspace
bun run test       # vitest
bun run lint       # biome
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). In short: open a PR, and run
`bun run changeset` to describe any change that should ship a release.

## License

[MIT](./LICENSE) © Quickbits
