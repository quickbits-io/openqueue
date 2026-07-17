# @openqueue/client

Fetch-only HTTP client for a deployed [OpenQueue](https://github.com/quickbits-io/openqueue)
worker. Trigger tasks, read runs, and manage schedules over the versioned
`/openqueue/v1` control API — with **zero** Redis or database connections. Safe
for Node 18+, Bun, and edge runtimes.

```ts
import { createClient } from '@openqueue/client';

const client = createClient({
  host: 'https://worker.example.com',
  auth: { bearer: process.env.OPENQUEUE_TOKEN! },
});

const { runId } = await client.trigger('send-email', { to: 'a@b.com' });
const run = await client.runs.poll(runId);
console.log(run.status); // 'completed'
```

## Auth

`auth.bearer` is a token string, or a resolver called per request (rotating
tokens survive):

```ts
createClient({ host, auth: { bearer: () => currentToken() } });
```

## Binding to `task().trigger()`

To make `myTask.trigger(input)` in your app go over HTTP, use the binding
wrapper from the SDK instead — `createClient` from `@openqueue/sdk/client`
registers the client as the process task runtime. Import from
`@openqueue/client` directly when you want an unbound client (edge, multi-target).

## Wire contract

The zod schemas backing the `/openqueue/v1` request/response bodies are exported
from `@openqueue/client/wire` for servers and tooling.
