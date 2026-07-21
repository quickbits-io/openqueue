# Changelog

## [1.0.0](https://github.com/quickbits-io/openqueue/compare/world-postgres-v0.1.4...world-postgres-v1.0.0) (2026-07-21)


### ⚠ BREAKING CHANGES

* the minimum supported Node version is now 20.11.1.
* **core:** shed bullmq/ioredis — world-only runtime factories

### Features

* **core:** shed bullmq/ioredis — world-only runtime factories ([eea7efc](https://github.com/quickbits-io/openqueue/commit/eea7efc5198a23a2840c992fa7c128b70c3be5ea))
* Node 20.11.1 floor across Node-capable packages + jose v6 ([f6667e6](https://github.com/quickbits-io/openqueue/commit/f6667e6c3fd0aeea48bb518a48cb8c11a36664a5))
* **world-postgres:** self-migrating Postgres world ([805a1c9](https://github.com/quickbits-io/openqueue/commit/805a1c9b4b9610bea6d3d204aa85c8bbbaf3bec7))


### Bug Fixes

* **world-postgres:** close the claim-fence holes in stall recovery and heartbeat ([fca25cc](https://github.com/quickbits-io/openqueue/commit/fca25cc8610c7d1b902e57ec9583d572d39e702d))
* **world-postgres:** fence progress persistence against lost claims ([d88f6c7](https://github.com/quickbits-io/openqueue/commit/d88f6c7553f930711bf9e124bf4d1a71c1bc9b46))
* **world-postgres:** fence settlement by the active claim token ([d4011a6](https://github.com/quickbits-io/openqueue/commit/d4011a63ad17dd1ef7058371b0898b8d7460c6b1))
* **world-postgres:** keep manual migration mode read-only ([2d7c789](https://github.com/quickbits-io/openqueue/commit/2d7c789d79bbd2223c84ce3aa9b466d3a6cba68f))
* **world-postgres:** refresh processed_on per claim and heartbeat through drain ([a75cf94](https://github.com/quickbits-io/openqueue/commit/a75cf948b11ed7b66fb21cb98c6a72bac740bbd1))
