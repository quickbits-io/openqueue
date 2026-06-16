/**
 * Compute the dashboard's base path from an incoming request URL.
 *
 * The dashboard defaults to the URL root. When it is mounted at a prefix
 * (e.g. `/jobs`), the client router renders deep links like
 * `/jobs/queues/email`, `/jobs/metrics`, `/jobs/flows/email/123`, etc. The
 * HTML `<base href>` needs to point at the mount prefix so client-side asset
 * URLs resolve correctly, so strip any client-side route segment from the
 * pathname.
 */
const CLIENT_ROUTES: RegExp[] = [
  /\/queues\/[^/]+\/jobs\/[^/]+\/?$/,
  /\/queues\/[^/]+\/?$/,
  /\/flows\/[^/]+\/[^/]+\/?$/,
  /\/runs\/?$/,
  /\/errors\/?$/,
  /\/schedulers\/?$/,
  /\/flows\/?$/,
  /\/metrics\/?$/,
  /\/alerts\/?$/,
  /\/test\/?$/,
];

export function computeBasePath(pathname: string): string {
  let basePath = pathname;
  for (const route of CLIENT_ROUTES) {
    basePath = basePath.replace(route, '');
  }
  if (!basePath.endsWith('/')) {
    basePath = `${basePath}/`;
  }
  return basePath;
}

/**
 * Resolve the dashboard's base path, preferring an explicit override.
 *
 * Adapters where the host framework preserves the mount prefix on the
 * incoming URL (Hono `.route()`, Express `req.originalUrl`, Next.js route
 * files) can rely on auto-detection. Adapters where the prefix is stripped
 * before the handler runs (Elysia `.mount()`) require the user to pass
 * `basePath` so the dashboard's HTML still references assets under the
 * correct prefix.
 */
export function resolveBasePath(
  override: string | undefined,
  pathname: string,
): string {
  if (override) {
    return override.endsWith('/') ? override : `${override}/`;
  }
  return computeBasePath(pathname);
}
