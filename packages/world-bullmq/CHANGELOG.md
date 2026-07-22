# Changelog

## [1.2.0](https://github.com/quickbits-io/openqueue/compare/world-bullmq-v1.1.0...world-bullmq-v1.2.0) (2026-07-22)


### Features

* **core:** retention policy for run history, events, and spans ([86fee4d](https://github.com/quickbits-io/openqueue/commit/86fee4ddcb12b3a51a5b9c2c6d749cf0bb3bc859))

## [1.1.0](https://github.com/quickbits-io/openqueue/compare/world-bullmq-v1.0.0...world-bullmq-v1.1.0) (2026-07-21)


### Miscellaneous Chores

* **world-bullmq:** Synchronize openqueue versions

## [1.0.0](https://github.com/quickbits-io/openqueue/compare/world-bullmq-v0.1.4...world-bullmq-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* **core:** `createQueueClient`, `QueueClient`, and `QueueClientOptions` are removed from @openqueue/core and the @openqueue/sdk/client subpath (which also drops its `QueueRunPollOptions` / `QueueRunsApi` re-exports; both remain on @openqueue/sdk). Replace with `createClient({ host })`, or `createControlRuntime` from @openqueue/core/control for an embedded producer plane.
* **core:** 1.0 surface-freeze sweep
* **world-bullmq:** extract the BullMQ world from core

### Features

* **core:** 1.0 surface-freeze sweep ([1c93047](https://github.com/quickbits-io/openqueue/commit/1c93047abeacdfce1a345e1d66d1d61c8e99f298))
* **core:** remove the in-process producer client (createQueueClient) ([6feda2f](https://github.com/quickbits-io/openqueue/commit/6feda2f4bc2e8d66cd94b7b4f39947c06fc488c9))
* **world-bullmq:** extract the BullMQ world from core ([0506510](https://github.com/quickbits-io/openqueue/commit/05065107b7aa1764fa521a7d6109464c83cad016))


### Bug Fixes

* **core:** don't resurrect terminal runs on duplicate enqueue ([8595806](https://github.com/quickbits-io/openqueue/commit/8595806c36004a1ac43a2f28c7548708b972e1c7))
* **world-bullmq:** close spawned consumers from transport.close ([8358210](https://github.com/quickbits-io/openqueue/commit/835821071bfe54ec73f170dcee3c011db800f677))
* **world-bullmq:** duplicate a worker-safe consumer for an injected producer ([f802b56](https://github.com/quickbits-io/openqueue/commit/f802b56fbeb76cd6c30d80ed45b0e77a88f81f59))
* **world-bullmq:** hoist the lazy consumer assignment out of expression position ([68487dd](https://github.com/quickbits-io/openqueue/commit/68487dd53d536463f7bc9272b932e305c1a18f1c))
* **world-bullmq:** keep closing resources after a worker close rejects ([dd852bd](https://github.com/quickbits-io/openqueue/commit/dd852bdef57518fd68524fc5e7d3708704db46f6))
* **world-bullmq:** quit owned clients even when transport close fails ([a67d116](https://github.com/quickbits-io/openqueue/commit/a67d116bffb25794b1d5b6d934e96372140ee4bb))
* **world-bullmq:** use a worker-safe connection in createBullmqTransport ([c6388de](https://github.com/quickbits-io/openqueue/commit/c6388dedfee96b3c61dc4fae6dedfffbfb06ea05))
