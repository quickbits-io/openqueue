# @openqueue/workbench

## [1.2.0](https://github.com/quickbits-io/openqueue/compare/workbench-v1.1.0...workbench-v1.2.0) (2026-07-22)


### Miscellaneous Chores

* **workbench:** Synchronize openqueue versions

## [1.1.0](https://github.com/quickbits-io/openqueue/compare/workbench-v1.0.0...workbench-v1.1.0) (2026-07-21)


### Miscellaneous Chores

* **workbench:** Synchronize openqueue versions

## [1.0.0](https://github.com/quickbits-io/openqueue/compare/workbench-v0.1.4...workbench-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* the minimum supported Node version is now 20.11.1.
* **workbench:** v1 wire polish — 404 envelope + 501 unsupported_capability
* **workbench:** the ./hono entry is removed — import from @openqueue/workbench/h3 (returns H3 apps) or use createFetchHandler from the main entry for any fetch-native host. engines.node is now >=20.11.1 (h3 v2 requirement). hono, @hono/zod-openapi and @scalar/hono-api-reference are no longer dependencies.

### Features

* Node 20.11.1 floor across Node-capable packages + jose v6 ([f6667e6](https://github.com/quickbits-io/openqueue/commit/f6667e6c3fd0aeea48bb518a48cb8c11a36664a5))
* **workbench:** /openqueue/v1 control API, h3 shell, lean ./control entry ([8b09af0](https://github.com/quickbits-io/openqueue/commit/8b09af0a1152dcc97a11f01748cb6d0774bf1b77))
* **workbench:** v1 wire polish — 404 envelope + 501 unsupported_capability ([240ca68](https://github.com/quickbits-io/openqueue/commit/240ca684eb306212d07e66efdfcada79d82d7a61))
* **worker:** resolve redis config sugar via world-bullmq ([7d3f1c9](https://github.com/quickbits-io/openqueue/commit/7d3f1c9cdfb7e3ef49a2866d7de6d1472f316d38))


### Bug Fixes

* **workbench:** bound the alert-manager cooldown map ([2a275e3](https://github.com/quickbits-io/openqueue/commit/2a275e396a2049dd93e42f3cb116fcf95f93e8dc))
* **workbench:** carry the catalog id on WorkbenchJobDefinition ([fa1a3ac](https://github.com/quickbits-io/openqueue/commit/fa1a3ac6bf7878d64622eb196febff2a9826aa0f))
* **workbench:** default-import cron-parser for Node ESM ([91db684](https://github.com/quickbits-io/openqueue/commit/91db6845fc277d1e1a2e58782e1c674551bc9c13))
* **workbench:** escape dots in the tenant segment of scoped ids ([aef7985](https://github.com/quickbits-io/openqueue/commit/aef7985d988734f9b6000e1f1d575d09edf8dbee))
* **workbench:** fail closed when the control API cannot read the environment ([9df7e5f](https://github.com/quickbits-io/openqueue/commit/9df7e5f11a44d4ebde42287553ca751c63874dd2))
* **workbench:** honor explicit empty queues in WorkbenchCore.fromOptions ([1e34763](https://github.com/quickbits-io/openqueue/commit/1e34763fa0a341fe8da144c958badd91c1121093))
* **workbench:** keep the SPA fallback GET-only so missed mutations 404 ([331963d](https://github.com/quickbits-io/openqueue/commit/331963da9d2b75abadde290b876f771e1a351667))
* **workbench:** leave world-owned alert stores to the runtime close path ([78aa105](https://github.com/quickbits-io/openqueue/commit/78aa1058d1af46f196dd46a7d303da781ec2af27))
* **workbench:** make tenant dedupe-key scoping idempotent ([877fa84](https://github.com/quickbits-io/openqueue/commit/877fa84db13d785a555f8a280ce0b4a71b227b11))
* **workbench:** map UnsupportedCapabilityError to 501 on the cancel route ([a3c2ae1](https://github.com/quickbits-io/openqueue/commit/a3c2ae12dc3e7c942cb8f7efab889fc6a7fc1c9b))
* **workbench:** scope enqueue ids and unify POST /jobs task resolution ([a2d4c29](https://github.com/quickbits-io/openqueue/commit/a2d4c29ac99623fbdc7d34a0d03116dab92fd5b8))
* **workbench:** tenant-scope schedule dedupe keys, wire schedule validation errors, edge-safe control app, honor empty queues ([cb1a74a](https://github.com/quickbits-io/openqueue/commit/cb1a74a9a65287f4f64776f8dec0be23190d8d49))
* **workbench:** thread alert-store ownership from WorkbenchCore ([dec6e4a](https://github.com/quickbits-io/openqueue/commit/dec6e4ad8770fb6e9acd22b29892d22f0cb76a41))
* **workbench:** thread the queue prefix into the Workbench FlowProducer ([0ecb0f7](https://github.com/quickbits-io/openqueue/commit/0ecb0f79b48b4e11c36a54dda8453f32528f0083))
* **workbench:** treat empty basic credentials as auth-off ([51ba442](https://github.com/quickbits-io/openqueue/commit/51ba4429517d28ccfaac51794074269e3dae5874))
* **workbench:** use a BullMQ-safe tenant id prefix for scoped enqueue ids ([fee49dd](https://github.com/quickbits-io/openqueue/commit/fee49dd5ab28cbf90ea1f39fe48f874548f2cabc))
* **worker:** close the workbench in WorkerAppHandle.close() ([de82ef6](https://github.com/quickbits-io/openqueue/commit/de82ef65da6d113d04a1250911e3a688832de68a))

## [0.1.4](https://github.com/quickbits-io/openqueue/compare/workbench-v0.1.3...workbench-v0.1.4) (2026-07-15)


### Miscellaneous Chores

* **workbench:** Synchronize openqueue versions

## [0.1.3](https://github.com/quickbits-io/openqueue/compare/workbench-v0.1.2...workbench-v0.1.3) (2026-07-04)


### Miscellaneous Chores

* **workbench:** Synchronize openqueue versions

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
