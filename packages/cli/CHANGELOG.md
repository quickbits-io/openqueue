# @openqueue/cli

## [1.2.0](https://github.com/quickbits-io/openqueue/compare/cli-v1.1.0...cli-v1.2.0) (2026-07-22)


### Miscellaneous Chores

* **cli:** Synchronize openqueue versions

## [1.1.0](https://github.com/quickbits-io/openqueue/compare/cli-v1.0.0...cli-v1.1.0) (2026-07-21)


### Features

* **cli:** sourcemap option for the Nitro artifact build ([e8c9276](https://github.com/quickbits-io/openqueue/commit/e8c92767b2b7fa9348a17c19633311c450ff01c1))

## [1.0.0](https://github.com/quickbits-io/openqueue/compare/cli-v0.1.4...cli-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* **cli:** build output moves from `.openqueue/build/manifest.mjs` to a Nitro server bundle at `.output` (configurable via `build.outDir`). The artifact runs on Node ^20.19 || >=22.12 or Bun.
* **core:** 1.0 surface-freeze sweep
* **core:** shed bullmq/ioredis — world-only runtime factories

### Features

* **cli:** openqueue build emits a Nitro server artifact (.output) ([384547a](https://github.com/quickbits-io/openqueue/commit/384547aba30e03f1045293466fecbe4014079002))
* **cli:** openqueue migrations print|status ([43af5ad](https://github.com/quickbits-io/openqueue/commit/43af5ad25fb64448aa4fdfb29429ffe185bea9bb))
* **cli:** openqueue start runs the Nitro artifact with health-gated readiness ([f05fc69](https://github.com/quickbits-io/openqueue/commit/f05fc69858db3b9783c352f77760f4d2b5a63ea8))
* **core:** 1.0 surface-freeze sweep ([1c93047](https://github.com/quickbits-io/openqueue/commit/1c93047abeacdfce1a345e1d66d1d61c8e99f298))
* **core:** shed bullmq/ioredis — world-only runtime factories ([eea7efc](https://github.com/quickbits-io/openqueue/commit/eea7efc5198a23a2840c992fa7c128b70c3be5ea))


### Bug Fixes

* **cli:** 1.0-correct init scaffold ([7e1032c](https://github.com/quickbits-io/openqueue/commit/7e1032c9f5091f27135d4048a7b9917fe9c9b38f))
* **cli:** copy configured extra files into the artifact ([460fccb](https://github.com/quickbits-io/openqueue/commit/460fccb28c4642f31699f2dde4d48781aee904e9))
* **cli:** keep build.extraFiles inside the artifact directory ([d86d0ba](https://github.com/quickbits-io/openqueue/commit/d86d0ba115daef40103cf2c692db6212467ee80b))
* **cli:** merge dirs+tasks discovery, load serially, exclude by root ([3f9e7f1](https://github.com/quickbits-io/openqueue/commit/3f9e7f13a6fd051e55ec05a45574fcc4dc3ced61))
* **cli:** reject PORT=0 when starting the built artifact ([483789a](https://github.com/quickbits-io/openqueue/commit/483789a8559f6ae239cbf23ed89736c312f6dbf2))
* **cli:** run the Nitro artifact under Node when available ([633cec3](https://github.com/quickbits-io/openqueue/commit/633cec34ec5fe0d4f332ce0c3933faa961c4bf6e))
* **cli:** validate PORT and honor build.external in the artifact ([40a16ac](https://github.com/quickbits-io/openqueue/commit/40a16acf6f58454bf56abb7de2291d27a8591e17))
* **cli:** validate the build through the generated boot module ([c82b3a9](https://github.com/quickbits-io/openqueue/commit/c82b3a9b10bb531c65f2e37afd4bdf1c44c927cf))

## [0.1.4](https://github.com/quickbits-io/openqueue/compare/cli-v0.1.3...cli-v0.1.4) (2026-07-15)


### Miscellaneous Chores

* **cli:** Synchronize openqueue versions

## [0.1.3](https://github.com/quickbits-io/openqueue/compare/cli-v0.1.2...cli-v0.1.3) (2026-07-04)


### Miscellaneous Chores

* **cli:** Synchronize openqueue versions

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
  - @openqueue/worker@0.1.2

## 0.1.1

### Patch Changes

- [#17](https://github.com/quickbits-io/openqueue/pull/17) [`59e91b8`](https://github.com/quickbits-io/openqueue/commit/59e91b822ea4b8f1a577875c3a54751df997cb1c) Thanks [@krzkz94](https://github.com/krzkz94)! - Fix published package metadata so npm consumers can install OpenQueue without workspace resolution, and expose the supported Workbench React UI entrypoint plus stylesheet.

- Updated dependencies [[`59e91b8`](https://github.com/quickbits-io/openqueue/commit/59e91b822ea4b8f1a577875c3a54751df997cb1c)]:
  - @openqueue/worker@0.1.1
  - @openqueue/core@0.1.1
