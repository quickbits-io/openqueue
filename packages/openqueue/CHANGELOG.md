# @openqueue/sdk

## [1.1.0](https://github.com/quickbits-io/openqueue/compare/sdk-v1.0.0...sdk-v1.1.0) (2026-07-21)


### Miscellaneous Chores

* **sdk:** Synchronize openqueue versions

## [1.0.0](https://github.com/quickbits-io/openqueue/compare/sdk-v0.1.4...sdk-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* **core:** `createQueueClient`, `QueueClient`, and `QueueClientOptions` are removed from @openqueue/core and the @openqueue/sdk/client subpath (which also drops its `QueueRunPollOptions` / `QueueRunsApi` re-exports; both remain on @openqueue/sdk). Replace with `createClient({ host })`, or `createControlRuntime` from @openqueue/core/control for an embedded producer plane.
* the minimum supported Node version is now 20.11.1.
* **core:** 1.0 surface-freeze sweep
* **core:** shed bullmq/ioredis — world-only runtime factories

### Features

* **core:** 1.0 surface-freeze sweep ([1c93047](https://github.com/quickbits-io/openqueue/commit/1c93047abeacdfce1a345e1d66d1d61c8e99f298))
* **core:** remove the in-process producer client (createQueueClient) ([6feda2f](https://github.com/quickbits-io/openqueue/commit/6feda2f4bc2e8d66cd94b7b4f39947c06fc488c9))
* **core:** shed bullmq/ioredis — world-only runtime factories ([eea7efc](https://github.com/quickbits-io/openqueue/commit/eea7efc5198a23a2840c992fa7c128b70c3be5ea))
* Node 20.11.1 floor across Node-capable packages + jose v6 ([f6667e6](https://github.com/quickbits-io/openqueue/commit/f6667e6c3fd0aeea48bb518a48cb8c11a36664a5))
* **sdk:** bindable HTTP client via @openqueue/sdk/client ([31f7851](https://github.com/quickbits-io/openqueue/commit/31f785167c1a6eb352d758f2740f6416f3c0f705))

## [0.1.4](https://github.com/quickbits-io/openqueue/compare/sdk-v0.1.3...sdk-v0.1.4) (2026-07-15)


### Miscellaneous Chores

* **sdk:** Synchronize openqueue versions

## [0.1.3](https://github.com/quickbits-io/openqueue/compare/sdk-v0.1.2...sdk-v0.1.3) (2026-07-04)


### Miscellaneous Chores

* **sdk:** Synchronize openqueue versions

## 0.1.2

### Patch Changes

- 4f99c86: Republish with correct internal dependency pins.

  0.1.1 shipped with internal `@openqueue/*` deps pinned to `0.1.0`: `changeset
version` bumped the manifests but left `bun.lock` stale, and `bun publish`
  resolves the `workspace:` protocol from the lockfile. The version step now runs
  `bun install --lockfile-only` after bumping so the lockfile's workspace versions
  match the release, and internal pins resolve to the published version.

- Updated dependencies [4f99c86]
  - @openqueue/core@0.1.2

## 0.1.1

### Patch Changes

- [#17](https://github.com/quickbits-io/openqueue/pull/17) [`59e91b8`](https://github.com/quickbits-io/openqueue/commit/59e91b822ea4b8f1a577875c3a54751df997cb1c) Thanks [@krzkz94](https://github.com/krzkz94)! - Fix published package metadata so npm consumers can install OpenQueue without workspace resolution, and expose the supported Workbench React UI entrypoint plus stylesheet.

- Updated dependencies []:
  - @openqueue/core@0.1.1
