# @openqueue/core

The runtime engine for [OpenQueue](https://github.com/quickbits-io/openqueue) —
typed tasks, queues, schedules, flows, and persistence on top of BullMQ + Redis.

Most applications should depend on
[`@openqueue/sdk`](https://www.npmjs.com/package/@openqueue/sdk), which
re-exports this package. Use `@openqueue/core` directly when you want the runtime
without the SDK surface.

```bash
bun add @openqueue/core
```

## Exports

| Entry | Contents |
| --- | --- |
| `@openqueue/core` | `task()`, `defineConfig()`, `createWorker()`, queues, schedules, flows, errors. |
| `@openqueue/core/drizzle` | `defineQueueSchema()`, `postgresAdapter()` — persist run history via Drizzle. |
| `@openqueue/core/types` | Shared type definitions. |

OpenTelemetry support is optional via the `@opentelemetry/*` peer dependencies.

Runs on Node 20.11+ or Bun.

## Documentation

See the [OpenQueue docs](https://github.com/quickbits-io/openqueue/tree/main/site/content/docs).

## License

[MIT](https://github.com/quickbits-io/openqueue/blob/main/LICENSE)
