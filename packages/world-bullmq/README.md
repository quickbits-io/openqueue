# @openqueue/world-bullmq

The **BullMQ world** for [OpenQueue](https://github.com/quickbits-io/openqueue):
a Redis-backed delivery transport paired with a write-through durable state store
(schedules, runs, alerts, catalog). This is OpenQueue's **default** delivery path
— `@openqueue/worker` resolves the `redis: { url }` config sugar to it for you.

```ts
import { defineConfig } from '@openqueue/sdk';

export default defineConfig({
  namespace: 'my-app',
  dirs: ['./worker'],
  // The worker resolves this to worldBullmq({ url, prefix, storage }).
  redis: { url: process.env.REDIS_URL! },
});
```

Reach for `worldBullmq` directly only when you compose a runtime yourself
(`createQueueWorker({ world })` or `createControlRuntime`) instead of going
through `worker.config.ts`:

```ts
import { createQueueWorker } from '@openqueue/core';
import { worldBullmq } from '@openqueue/world-bullmq';

const runtime = await createQueueWorker({
  world: worldBullmq({ url: process.env.REDIS_URL! }),
  tasks,
});
```

## Options

```ts
worldBullmq({
  url?: string,            // the world creates + owns a producer + blocking consumer, quits both on close
  producer?: Redis,        // an existing ioredis client; XOR with url, left open
  consumer?: Redis,        // optional blocking connection for consumers; defaults to producer
  prefix?: string,         // root BullMQ key prefix; keys are `${prefix}:${namespace}`. Default 'bull'
  storage?: QueueStorage,  // durable store (e.g. postgresAdapter) — also the sole catalog fallback
});
```

Provide exactly one of `url` or `producer`. With `url` the world owns its clients
and quits them on `close()`; with `producer` the caller keeps ownership and the
world leaves the connection open.

## Durable state

Schedules, runs, alerts, and the queue catalog are written through to Redis for
low-latency reads. Pass a `storage` (typically `postgresAdapter`) to back that
cache with a durable store; it is also the sole catalog fallback consulted when
Redis misses. Without `storage`, state lives only in Redis (bounded caches with
TTLs), which is fine for development.

## Transport

```ts
import { createBullmqTransport, isBullmqTransport } from '@openqueue/world-bullmq';
```

`createBullmqTransport` builds the raw `QueueTransport` the world wraps; the
`BullmqTransport` it returns adds a `queue(name)` escape hatch for the
BullMQ-scoped Workbench dashboard. `isBullmqTransport(runtime.transport)` narrows
a runtime's transport so tooling can reach those BullMQ `Queue` instances (the
worker uses it for the dashboard and Prometheus metrics).

## Runtime

Node 20.11+ and Bun. Ships ESM + `.d.ts`. Depends on `@openqueue/core`,
`bullmq`, and `ioredis`. Keep the `bullmq` range identical to
`@openqueue/workbench`'s — live `Queue` instances cross that boundary.
