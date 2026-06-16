# @openqueue/worker

The worker runtime for [OpenQueue](https://github.com/quickbits-io/openqueue) —
loads your `worker.config.ts`, discovers and runs tasks, registers schedules, and
serves the [Workbench](https://www.npmjs.com/package/@openqueue/workbench)
dashboard.

> **Bun-native.** This package uses `Bun.serve` and is intended to run on
> [Bun](https://bun.sh).

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
