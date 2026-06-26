# @openqueue/core

## 0.1.2

### Patch Changes

- 4f99c86: Republish with correct internal dependency pins.

  0.1.1 shipped with internal `@openqueue/*` deps pinned to `0.1.0`: `changeset
version` bumped the manifests but left `bun.lock` stale, and `bun publish`
  resolves the `workspace:` protocol from the lockfile. The version step now runs
  `bun install --lockfile-only` after bumping so the lockfile's workspace versions
  match the release, and internal pins resolve to the published version.

## 0.1.1
