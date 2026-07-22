# Changelog

## [1.2.0](https://github.com/quickbits-io/openqueue/compare/client-v1.1.0...client-v1.2.0) (2026-07-22)


### Miscellaneous Chores

* **client:** Synchronize openqueue versions

## [1.1.0](https://github.com/quickbits-io/openqueue/compare/client-v1.0.0...client-v1.1.0) (2026-07-21)


### Miscellaneous Chores

* **client:** Synchronize openqueue versions

## [1.0.0](https://github.com/quickbits-io/openqueue/compare/client-v0.1.4...client-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* **core:** `createQueueClient`, `QueueClient`, and `QueueClientOptions` are removed from @openqueue/core and the @openqueue/sdk/client subpath (which also drops its `QueueRunPollOptions` / `QueueRunsApi` re-exports; both remain on @openqueue/sdk). Replace with `createClient({ host })`, or `createControlRuntime` from @openqueue/core/control for an embedded producer plane.
* the minimum supported Node version is now 20.11.1.
* **client:** freeze the /openqueue/v1 wire schema

### Features

* **client:** add @openqueue/client — fetch-only HTTP client ([418e7f6](https://github.com/quickbits-io/openqueue/commit/418e7f6f9f526038954779ddd29f6c403cb12093))
* **client:** freeze the /openqueue/v1 wire schema ([ca7626e](https://github.com/quickbits-io/openqueue/commit/ca7626ee4d35c910d7484a9811e5c9de4d69b661))
* **client:** per-request timeout option (timeoutMs, default 10s) ([d7c1d3f](https://github.com/quickbits-io/openqueue/commit/d7c1d3f7dfba69443058511d6e3dfa7cb1629650))
* **core:** remove the in-process producer client (createQueueClient) ([6feda2f](https://github.com/quickbits-io/openqueue/commit/6feda2f4bc2e8d66cd94b7b4f39947c06fc488c9))
* Node 20.11.1 floor across Node-capable packages + jose v6 ([f6667e6](https://github.com/quickbits-io/openqueue/commit/f6667e6c3fd0aeea48bb518a48cb8c11a36664a5))
