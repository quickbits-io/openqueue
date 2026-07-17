/**
 * `@openqueue/workbench/h3` — h3-typed adapter helpers.
 *
 * These exports return `H3` app instances, so they live in a dedicated entry
 * that quarantines the `h3` types away from the main `@openqueue/workbench`
 * surface. Consumers that only need the framework-neutral surface should import
 * `buildRouteTable` + `createFetchHandler` from `@openqueue/workbench` instead —
 * those reference no framework in their public types and mount into any
 * fetch-native host (h3, Hono, Elysia) or a Next.js route.
 *
 * The `/h3` name is deliberate: these helpers return h3 app instances, so a
 * neutral name would hide the runtime requirement.
 *
 * Used by:
 *   - `@openqueue/workbench/h3` — needs `buildWorkbenchApp` to return an `H3`
 *   - `apps/desktop/sidecar` — needs `buildWorkbenchApiApp`
 */

import type { Queue } from 'bullmq';
import { WorkbenchCore, type WorkbenchOptions } from './index';

export { createApiRoutes } from './api/router';
export { buildControlApp } from './api/v1/app';
export {
  buildWorkbenchApiApp,
  buildWorkbenchApiRouter,
} from './server/h3-api-app';
export { buildWorkbenchApp } from './server/h3-app';

/**
 * Build a fully-wired h3 app from the public Workbench options shape.
 * Uses Redis queue discovery when `redis` is provided without explicit queues.
 */
export async function createWorkbenchApp(options: WorkbenchOptions | Queue[]) {
  const core =
    Array.isArray(options) || options.queues?.length
      ? new WorkbenchCore(options)
      : await WorkbenchCore.fromOptions(options);
  const { buildWorkbenchApp } = await import('./server/h3-app');
  return buildWorkbenchApp(core);
}
