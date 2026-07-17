/**
 * `@openqueue/workbench/control` — the control-API surface with a bundle graph
 * free of the Redis/BullMQ stack (auth flows through `@openqueue/core/auth`), so
 * a two-plane deployment can serve `buildControlApp` from an edge/serverless
 * runtime.
 *
 * {@link ControlRuntime} here omits `close` (the workbench never owns the
 * runtime lifecycle); the `ControlRuntime` returned by
 * `@openqueue/core`'s `createControlRuntime` adds `close` and is structurally
 * assignable to it, so it drops straight into `buildControlApp`.
 */
export { buildControlApp } from './api/v1/app';
export type {
  ControlAuth,
  ControlAuthConfig,
  ControlAuthDecision,
} from './api/v1/auth';
export type { ControlApiOptions, ControlRuntime } from './api/v1/routes';
