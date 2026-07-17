# @openqueue/example-nextjs

A minimal Next.js app that dispatches and inspects OpenQueue jobs entirely over
HTTP through `@openqueue/sdk/client` — the app imports no Redis, Postgres, or
BullMQ. It talks to the `examples/basic` worker.

## One command

From the repo root, `bun run dev` starts everything (worker on :8090, this app
on :3100, plus the docs site and workbench dev server). Only the services need
to be up first: `docker compose up --wait`.

## Two-process story (manual)

1. **Start the stack** (repo root):

   ```bash
   docker compose up --wait
   ```

2. **Run the worker** — this serves the control API at
   `http://localhost:8090/openqueue/v1` and defines the `example` task:

   ```bash
   cd examples/basic
   bun run dev
   ```

3. **Run the app**:

   ```bash
   cd examples/nextjs
   cp .env.example .env.local   # optional; defaults point at localhost:8090
   bun run dev
   ```

4. Open `http://localhost:3100`, submit the form. The server action calls
   `openqueue.trigger('example', …)` and redirects to `/runs/<id>`, which reads
   the run status through the client. Refresh until it flips to `completed`.

## Auth

The worker's control API is open in development. To require a token, set the
same `OPENQUEUE_API_TOKEN` on both sides:

```bash
# examples/basic/.env
OPENQUEUE_API_TOKEN=dev-token

# examples/nextjs/.env.local
OPENQUEUE_API_TOKEN=dev-token
```

The client sends it as a bearer token; the worker verifies it.
