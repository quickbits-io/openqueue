# @openqueue/workbench

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
