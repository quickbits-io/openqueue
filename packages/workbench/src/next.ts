import type { Queue } from 'bullmq';
import { createFetchHandler, type WorkbenchOptions } from './index';

type NextRouteHandler = (req: Request) => Promise<Response>;

export interface WorkbenchHandlers {
  GET: NextRouteHandler;
  POST: NextRouteHandler;
  PUT: NextRouteHandler;
  PATCH: NextRouteHandler;
  DELETE: NextRouteHandler;
}

/**
 * Mount the Workbench dashboard on a Next.js App Router catch-all route.
 *
 * Place this in `app/[[...workbench]]/route.ts` to serve Workbench at the app
 * root, or `app/<mount>/[[...workbench]]/route.ts` to serve it at `/<mount>`.
 *
 * Leave `basePath` unset for a root route. Set it to the mount directory
 * (for example `/admin/jobs`) when the route lives below the root so API
 * requests are stripped back to Workbench's internal `/api/*` routes.
 */
export function workbench(
  options: WorkbenchOptions | Queue[],
): WorkbenchHandlers {
  const { fetch } = createFetchHandler(options);
  return {
    GET: fetch,
    POST: fetch,
    PUT: fetch,
    PATCH: fetch,
    DELETE: fetch,
  };
}

export type { WorkbenchOptions } from './index';
