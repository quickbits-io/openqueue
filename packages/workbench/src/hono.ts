/**
 * `@openqueue/workbench/hono` — Hono-typed adapter helpers.
 *
 * These exports live in a dedicated entry so the main `@openqueue/workbench`
 * surface doesn't leak `hono` types into consumers that don't use Hono.
 * Hono 4 ships type declarations that use `const` type parameters (a
 * TypeScript 5.0 feature), and pulling them transitively through the
 * default entry broke `tsc` builds on TypeScript 4.x — including for
 * users of the Express, Fastify, NestJS, Next.js, and Elysia adapters
 * who never import Hono themselves.
 *
 * Used by:
 *   - `@openqueue/workbench/hono` — needs `buildWorkbenchApp` to return a `Hono`
 *   - `apps/desktop/sidecar` — needs `buildWorkbenchApiApp`
 *
 * If you're writing a new adapter that doesn't return a `Hono` instance,
 * prefer `buildRouteTable` + `createFetchHandler` from `@openqueue/workbench`
 * instead — those don't reference `hono` in their public types.
 */

import type { Queue } from 'bullmq';
import { WorkbenchCore, type WorkbenchOptions } from './index';

export { createApiRoutes } from './api/router';
export {
  buildWorkbenchApiApp,
  buildWorkbenchApiRouter,
} from './server/hono-api-app';
export { buildWorkbenchApp } from './server/hono-app';

/**
 * Build a fully-wired Hono app from the public Workbench options shape.
 * Uses Redis queue discovery when `redis` is provided without explicit queues.
 */
export async function createWorkbenchApp(options: WorkbenchOptions | Queue[]) {
  const core =
    Array.isArray(options) || options.queues?.length
      ? new WorkbenchCore(options)
      : await WorkbenchCore.fromOptions(options);
  const { buildWorkbenchApp } = await import('./server/hono-app');
  return buildWorkbenchApp(core);
}
