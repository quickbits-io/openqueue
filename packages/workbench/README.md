# @openqueue/workbench

The Workbench dashboard for
[OpenQueue](https://github.com/quickbits-io/openqueue) — live queue counters, run
inspection, retry-from-the-UI, flow graphs, schedules, error triage, alerts, and
a test console for BullMQ / OpenQueue queues.

It ships a prebuilt React SPA (served from disk) plus framework adapters, so you
can run it standalone inside an [`@openqueue/worker`](https://www.npmjs.com/package/@openqueue/worker)
or mount it into an existing app.

```bash
bun add @openqueue/workbench
```

## Exports

| Entry | Use |
| --- | --- |
| `@openqueue/workbench` | Core (`WorkbenchCore`, `QueueManager`, `createFetchHandler`, route helpers). |
| `@openqueue/workbench/h3` | `buildWorkbenchApp` / `createWorkbenchApp` — a ready-to-mount h3 app. |
| `@openqueue/workbench/next` | `workbench()` — Next.js App Router catch-all route handlers. |

```ts
// app/admin/jobs/[[...workbench]]/route.ts
import { workbench } from '@openqueue/workbench/next';

export const { GET, POST, PUT, PATCH, DELETE } = workbench({
  redis: { url: process.env.REDIS_URL! },
  basePath: '/admin/jobs',
});
```

Runs on Node 20.11+ or Bun. React is bundled into the prebuilt UI — consumers of
the adapters don't need to install it.

## Documentation

See the [OpenQueue docs](https://github.com/quickbits-io/openqueue/tree/main/site/content/docs).

## License

[MIT](https://github.com/quickbits-io/openqueue/blob/main/LICENSE)
