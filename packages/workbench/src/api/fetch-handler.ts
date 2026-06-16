import type { Queue } from 'bullmq';
import type { WorkbenchOptions } from '../core/types';
import { WorkbenchCore } from '../core/workbench';
import { buildWorkbenchApp } from '../server/hono-app';

export interface FetchHandlerResult {
  /**
   * Web-standard fetch handler. Accepts a `Request` and returns a `Response`.
   * Suitable for Elysia's `.mount(path, handler)`, Next.js route handlers,
   * Bun.serve, and any other web-standards-friendly runtime.
   */
  fetch: (req: Request) => Promise<Response>;
  /**
   * The underlying `WorkbenchCore` instance when it can be built
   * synchronously. This is `null` for redis-discovery mode; use `ready` when
   * adapter code needs the discovered core.
   */
  core: WorkbenchCore | null;
  /**
   * Resolves to the initialized core. In `redis`-only mode this waits for
   * BullMQ queue discovery before API/UI requests are served.
   */
  ready: Promise<WorkbenchCore>;
}

/**
 * Build a self-contained web-fetch handler for Workbench: API routes,
 * `/config`, static `/assets/:file`, an `index.html` catch-all with a
 * correct `<base href>`, CORS on `/api/*`, and optional Basic Auth on
 * everything.
 *
 * This is the engine shared by every fetch-native adapter (Elysia, Next.js).
 * Express and Fastify adapters use {@link buildRouteTable} directly instead.
 *
 * Without `options.basePath`, the dashboard is served from the URL root. When
 * `basePath` is set, the handler rewrites the incoming Request URL to strip
 * that prefix before routing. This makes the bridge work uniformly for both
 * fetch hosts:
 *
 * - `Elysia.mount()` already strips the prefix before calling us — the
 *   strip below is a no-op in that case.
 * - Next.js App Router preserves the full path — the strip is what lets
 *   our internal routes (`/api/*`, `/config`, …) match.
 */
export function createFetchHandler(
  options: WorkbenchOptions | Queue[],
): FetchHandlerResult {
  const normalizedOptions: WorkbenchOptions = Array.isArray(options)
    ? { queues: options }
    : options;
  const shouldDiscoverQueues =
    !normalizedOptions.queues?.length && !!normalizedOptions.redis;
  const core = shouldDiscoverQueues ? null : new WorkbenchCore(options);
  const ready = core
    ? Promise.resolve(core)
    : WorkbenchCore.fromOptions(normalizedOptions);
  let appReady: Promise<ReturnType<typeof buildWorkbenchApp>> | null = null;
  const basePath = normalizeBasePath(normalizedOptions.basePath);

  const getApp = () => {
    appReady ??= ready.then((initializedCore) =>
      buildWorkbenchApp(initializedCore),
    );
    return appReady;
  };

  const fetchHandler = async (req: Request): Promise<Response> => {
    let app: Awaited<ReturnType<typeof getApp>>;
    try {
      app = await getApp();
    } catch (error) {
      return new Response(
        error instanceof Error
          ? error.message
          : 'Failed to initialize Workbench',
        { status: 500 },
      );
    }

    if (basePath) {
      const url = new URL(req.url);
      if (
        url.pathname === basePath ||
        url.pathname.startsWith(`${basePath}/`)
      ) {
        const rewritten = url.pathname.slice(basePath.length) || '/';
        url.pathname = rewritten;
        // `duplex` is required when sending a streaming body in Node 18+ but is
        // not yet in the lib.dom `RequestInit` type.
        const init: RequestInit & { duplex: 'half' } = {
          method: req.method,
          headers: req.headers,
          body:
            req.method === 'GET' || req.method === 'HEAD'
              ? undefined
              : req.body,
          duplex: 'half',
          redirect: req.redirect,
        };
        return app.fetch(new Request(url.toString(), init));
      }
    }
    return app.fetch(req);
  };

  return {
    fetch: fetchHandler,
    core,
    ready,
  };
}

/**
 * Normalize a base path: trim trailing slashes so we can do exact prefix
 * comparisons without double-slashes. Returns `null` for the default mount
 * (`""` or `"/"`) so the no-strip fast path runs.
 */
function normalizeBasePath(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  if (trimmed === '' || trimmed === '/') return null;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}
