# @openqueue/core

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
