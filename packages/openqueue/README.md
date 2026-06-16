# @openqueue/sdk

The main entrypoint for [OpenQueue](https://github.com/quickbits-io/openqueue) —
a batteries-included background job framework for TypeScript, built on BullMQ and
Redis.

```bash
bun add @openqueue/sdk
```

```ts
import { task, defineConfig } from '@openqueue/sdk';
import { z } from 'zod';

export const sendWelcome = task({
  id: 'send-welcome',
  schema: z.object({ email: z.string().email() }),
  run: async (payload, ctx) => {
    ctx.logger.info('sending welcome email', { email: payload.email });
    return { ok: true };
  },
});

await sendWelcome.trigger({ email: 'alex@example.com' });
```

`@openqueue/sdk` re-exports [`@openqueue/core`](https://www.npmjs.com/package/@openqueue/core):
`task()`, `defineConfig()`, `enqueue()`/`enqueueFlow()`, the error taxonomy, and
the persistence adapters.

Pair it with [`@openqueue/cli`](https://www.npmjs.com/package/@openqueue/cli) to
scaffold and run a worker:

```bash
bun add -d @openqueue/cli
bunx openqueue init
bunx openqueue dev
```

## Documentation

See the [OpenQueue docs](https://github.com/quickbits-io/openqueue/tree/main/site/content/docs).

## License

[MIT](https://github.com/quickbits-io/openqueue/blob/main/LICENSE)
