# @openqueue/worker

## [1.2.0](https://github.com/quickbits-io/openqueue/compare/worker-v1.1.0...worker-v1.2.0) (2026-07-22)


### Features

* **worker:** hourly retention sweep ([dd4a34a](https://github.com/quickbits-io/openqueue/commit/dd4a34a1b1080e5a5744d1de449a8cb374c752b4))


### Bug Fixes

* **worker:** jitter the retention sweep and wire it for embedded runtimes ([1061085](https://github.com/quickbits-io/openqueue/commit/1061085a09ac6793fd2f998c21f3c61e88fbae7a))

## [1.1.0](https://github.com/quickbits-io/openqueue/compare/worker-v1.0.0...worker-v1.1.0) (2026-07-21)


### Miscellaneous Chores

* **worker:** Synchronize openqueue versions

## [1.0.0](https://github.com/quickbits-io/openqueue/compare/worker-v0.1.4...worker-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* **core:** 1.0 surface-freeze sweep

### Features

* **core:** 1.0 surface-freeze sweep ([1c93047](https://github.com/quickbits-io/openqueue/commit/1c93047abeacdfce1a345e1d66d1d61c8e99f298))
* **worker:** @openqueue/worker/nitro boot plugin entry ([3bb16e8](https://github.com/quickbits-io/openqueue/commit/3bb16e8cddb49a552106a9634f7b6aaed3b3e072))
* **worker:** host the worker app on h3 serve and extract createWorkerApp ([719ddc0](https://github.com/quickbits-io/openqueue/commit/719ddc02238394e9b98b23fcf47d03a6cf2694c9))
* **worker:** resolve redis config sugar via world-bullmq ([7d3f1c9](https://github.com/quickbits-io/openqueue/commit/7d3f1c9cdfb7e3ef49a2866d7de6d1472f316d38))
* **worker:** world-backed config, control API mount, bound port ([59943eb](https://github.com/quickbits-io/openqueue/commit/59943eb9b78aaec018a7923783870e813d2e823d))


### Bug Fixes

* **workbench:** fail closed when the control API cannot read the environment ([9df7e5f](https://github.com/quickbits-io/openqueue/commit/9df7e5f11a44d4ebde42287553ca751c63874dd2))
* **worker:** close the workbench in WorkerAppHandle.close() ([de82ef6](https://github.com/quickbits-io/openqueue/commit/de82ef65da6d113d04a1250911e3a688832de68a))
* **worker:** default the Workbench basePath to its /workbench mount ([9dcac1f](https://github.com/quickbits-io/openqueue/commit/9dcac1fce9fcb2bd3f7a601e6fa433981a01dc41))
* **worker:** honor programmatic tasks and normalize single-task exports ([734f804](https://github.com/quickbits-io/openqueue/commit/734f804f47de0e04fcdc6c117abc15a30ba49969))
* **worker:** merge dirs+tasks discovery and trigger test jobs by id ([450b3c0](https://github.com/quickbits-io/openqueue/commit/450b3c0d7b059bbd87f6d8917d311f8f944574ca))
* **worker:** propagate runtime close failures to callers and exit codes ([b12f876](https://github.com/quickbits-io/openqueue/commit/b12f8764bb12772251342546b824522fda20eb09))
* **worker:** reject a second nitro worker plugin initialization ([3a9da4e](https://github.com/quickbits-io/openqueue/commit/3a9da4e1e3c37b542affad25c56daea7cbc8b7ba))
* **worker:** resolve tasks a config statically imports ([9597510](https://github.com/quickbits-io/openqueue/commit/9597510f745e20304be8b615a0da05db8e6eeec2))

## [0.1.4](https://github.com/quickbits-io/openqueue/compare/worker-v0.1.3...worker-v0.1.4) (2026-07-15)


### Miscellaneous Chores

* **worker:** Synchronize openqueue versions

## [0.1.3](https://github.com/quickbits-io/openqueue/compare/worker-v0.1.2...worker-v0.1.3) (2026-07-04)


### Miscellaneous Chores

* **worker:** Synchronize openqueue versions

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
  - @openqueue/workbench@0.1.2

## 0.1.1

### Patch Changes

- [#17](https://github.com/quickbits-io/openqueue/pull/17) [`59e91b8`](https://github.com/quickbits-io/openqueue/commit/59e91b822ea4b8f1a577875c3a54751df997cb1c) Thanks [@krzkz94](https://github.com/krzkz94)! - Fix published package metadata so npm consumers can install OpenQueue without workspace resolution, and expose the supported Workbench React UI entrypoint plus stylesheet.

- Updated dependencies [[`59e91b8`](https://github.com/quickbits-io/openqueue/commit/59e91b822ea4b8f1a577875c3a54751df997cb1c)]:
  - @openqueue/workbench@0.1.1
  - @openqueue/core@0.1.1
