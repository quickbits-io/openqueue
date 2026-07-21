# @openqueue/worker

The worker runtime for [OpenQueue](https://github.com/quickbits-io/openqueue) —
loads your `worker.config.ts`, discovers and runs tasks, registers schedules, and
serves the [Workbench](https://www.npmjs.com/package/@openqueue/workbench)
dashboard.

> **Runs on Node 20.11+ or Bun.** The worker hosts its h3 app on
> [srvx](https://srvx.h3.dev); `@openqueue/cli` compiles it into a Nitro
> production artifact via `openqueue build`.

Most users drive the worker through
[`@openqueue/cli`](https://www.npmjs.com/package/@openqueue/cli)
(`openqueue dev` / `openqueue start`). Depend on `@openqueue/worker` directly when
you want to embed or customize the worker app.

```bash
bun add @openqueue/worker
```

```ts
import { startWorkerApp, loadConfig } from '@openqueue/worker';

const config = await loadConfig();
await startWorkerApp(config);
```

## Documentation

See the [OpenQueue docs](https://github.com/quickbits-io/openqueue/tree/main/site/content/docs).

## License

[MIT](https://github.com/quickbits-io/openqueue/blob/main/LICENSE)
