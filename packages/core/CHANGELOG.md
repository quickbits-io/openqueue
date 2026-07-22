# @openqueue/core

## [1.2.0](https://github.com/quickbits-io/openqueue/compare/core-v1.1.0...core-v1.2.0) (2026-07-22)


### Features

* **core:** retention policy for run history, events, and spans ([86fee4d](https://github.com/quickbits-io/openqueue/commit/86fee4ddcb12b3a51a5b9c2c6d749cf0bb3bc859))
* **worker:** hourly retention sweep ([dd4a34a](https://github.com/quickbits-io/openqueue/commit/dd4a34a1b1080e5a5744d1de449a8cb374c752b4))


### Bug Fixes

* **core:** batch and coordinate the retention prune ([fc973e6](https://github.com/quickbits-io/openqueue/commit/fc973e62ed20b55ec4e8f4c76743088c80f39790))
* **worker:** jitter the retention sweep and wire it for embedded runtimes ([1061085](https://github.com/quickbits-io/openqueue/commit/1061085a09ac6793fd2f998c21f3c61e88fbae7a))

## [1.1.0](https://github.com/quickbits-io/openqueue/compare/core-v1.0.0...core-v1.1.0) (2026-07-21)


### Features

* **cli:** sourcemap option for the Nitro artifact build ([e8c9276](https://github.com/quickbits-io/openqueue/commit/e8c92767b2b7fa9348a17c19633311c450ff01c1))

## [1.0.0](https://github.com/quickbits-io/openqueue/compare/core-v0.1.4...core-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* **core:** `createQueueClient`, `QueueClient`, and `QueueClientOptions` are removed from @openqueue/core and the @openqueue/sdk/client subpath (which also drops its `QueueRunPollOptions` / `QueueRunsApi` re-exports; both remain on @openqueue/sdk). Replace with `createClient({ host })`, or `createControlRuntime` from @openqueue/core/control for an embedded producer plane.
* the minimum supported Node version is now 20.11.1.
* **core:** 1.0 surface-freeze sweep
* **core:** shed bullmq/ioredis — world-only runtime factories
* **world-bullmq:** extract the BullMQ world from core
* **core:** CreateQueueWorkerOptions is now a discriminated union (redis XOR world); interfaces extending it must adapt. QueueConfig.redis is optional when world is set. Redis-path meta filters now deep-match like Postgres @> (previously object filters never matched). A configured but unresolved tenantClaim now fails closed (401) instead of granting cross-tenant access. Invalid run/schedule list-query values now return 400.

### Features

* **core:** 1.0 surface-freeze sweep ([1c93047](https://github.com/quickbits-io/openqueue/commit/1c93047abeacdfce1a345e1d66d1d61c8e99f298))
* **core:** remove the in-process producer client (createQueueClient) ([6feda2f](https://github.com/quickbits-io/openqueue/commit/6feda2f4bc2e8d66cd94b7b4f39947c06fc488c9))
* **core:** shed bullmq/ioredis — world-only runtime factories ([eea7efc](https://github.com/quickbits-io/openqueue/commit/eea7efc5198a23a2840c992fa7c128b70c3be5ea))
* **core:** ship OpenTelemetry as regular dependencies ([8e8f7f5](https://github.com/quickbits-io/openqueue/commit/8e8f7f56b889819c1c725a4a4dde1f119061db90))
* **core:** subjectClaim matcher for JWT auth strategies ([1b10d86](https://github.com/quickbits-io/openqueue/commit/1b10d86c1d2ba8a454e6d9eff1f84ae0cc333688))
* **core:** worlds, transports, auth strategies, control runtime ([c60a92c](https://github.com/quickbits-io/openqueue/commit/c60a92c3690b2c3b3828747f74c355a676729f0b))
* Node 20.11.1 floor across Node-capable packages + jose v6 ([f6667e6](https://github.com/quickbits-io/openqueue/commit/f6667e6c3fd0aeea48bb518a48cb8c11a36664a5))
* **world-bullmq:** extract the BullMQ world from core ([0506510](https://github.com/quickbits-io/openqueue/commit/05065107b7aa1764fa521a7d6109464c83cad016))


### Bug Fixes

* **core:** always close the world after a consumer close fails ([a7bd189](https://github.com/quickbits-io/openqueue/commit/a7bd189b83fdbf484876de813367a0f93ffb53e8))
* **core:** assert schedule delay support before persisting ([6813940](https://github.com/quickbits-io/openqueue/commit/6813940c015ae61e560e6178065d220b9710cb1f))
* **core:** bind ctx.trigger to its runtime, undefined-on-miss catalog.resolve, typed schedule errors ([bcaf126](https://github.com/quickbits-io/openqueue/commit/bcaf1261679a15ddfed9bccb37c52b70c7135eb2))
* **core:** cap the in-memory run cache (world-local) ([8fb47d5](https://github.com/quickbits-io/openqueue/commit/8fb47d5f945d0a36533bdb24307e369acbdb59d0))
* **core:** clear stale memory schedule dedupe keys on key change ([28a0a7e](https://github.com/quickbits-io/openqueue/commit/28a0a7e3a8bb4d608fb21116e029e67dcd74a4cf))
* **core:** close the world when worker boot fails ([96029d4](https://github.com/quickbits-io/openqueue/commit/96029d4610e89b2f9e308d2fe0d62474dc6d4687))
* **core:** don't resurrect terminal runs on duplicate enqueue ([8595806](https://github.com/quickbits-io/openqueue/commit/8595806c36004a1ac43a2f28c7548708b972e1c7))
* **core:** recover undefined task input across serialization ([bb1a2a4](https://github.com/quickbits-io/openqueue/commit/bb1a2a4f8d7dfebf6b29d1031ea3ef86738bfc61))
* **core:** report the active transport as messaging.system on attempt spans ([74830b2](https://github.com/quickbits-io/openqueue/commit/74830b28119e8bf108febda3bf56a828a93d0137))
* **core:** stamp the local transport's processedOn on every attempt ([41fb214](https://github.com/quickbits-io/openqueue/commit/41fb214b76bddcda2c7ca3dc3619f49934f99f51))

## [0.1.4](https://github.com/quickbits-io/openqueue/compare/core-v0.1.3...core-v0.1.4) (2026-07-15)


### Bug Fixes

* **core:** support cron parser in Node ESM ([#35](https://github.com/quickbits-io/openqueue/issues/35)) ([8d20258](https://github.com/quickbits-io/openqueue/commit/8d2025835ce0fae0f709bc84e83b0b68315f1776))

## [0.1.3](https://github.com/quickbits-io/openqueue/compare/core-v0.1.2...core-v0.1.3) (2026-07-04)


### Bug Fixes

* **core:** stream job logs write-through instead of retaining every write ([#24](https://github.com/quickbits-io/openqueue/issues/24)) ([d644a86](https://github.com/quickbits-io/openqueue/commit/d644a8694db9ccd9d5b07fb623ef42cd06e9563d))

## 0.1.2

### Patch Changes

- 4f99c86: Republish with correct internal dependency pins.

  0.1.1 shipped with internal `@openqueue/*` deps pinned to `0.1.0`: `changeset
version` bumped the manifests but left `bun.lock` stale, and `bun publish`
  resolves the `workspace:` protocol from the lockfile. The version step now runs
  `bun install --lockfile-only` after bumping so the lockfile's workspace versions
  match the release, and internal pins resolve to the published version.

## 0.1.1
