/**
 * Runtime-configurable API base URL for the dashboard.
 *
 * Three modes:
 *
 * - Default (adapter consumers): no base is set, the dashboard uses relative
 *   `./api/*` paths, and the `<base href>` injected by the host server makes
 *   them resolve correctly against the mount path.
 * - Host-injected (Tauri desktop): the host page sets
 *   `window.__WORKBENCH_RUNTIME__ = { apiBase: "http://127.0.0.1:54321" }`
 *   before the React tree mounts. Reading the global at request time means
 *   the host can swap connections (sidecar restart) without remounting.
 * - Programmatic: `setApiBase(url)` for tests and unusual embeddings.
 */

declare global {
  interface Window {
    __WORKBENCH_RUNTIME__?: {
      apiBase?: string;
      apiRoot?: string;
      headers?: HeaderSource;
    };
  }
}

export type HeaderSource =
  | HeadersInit
  | (() => HeadersInit | Promise<HeadersInit>);

let overrideBase: string | null = null;
let overrideRoot: string | null = null;
let overrideHeaders: HeaderSource | null = null;

/**
 * Programmatically set the API base URL. Pass `null` to fall back to the
 * `window.__WORKBENCH_RUNTIME__.apiBase` / relative default.
 */
export function setApiBase(base: string | null): void {
  overrideBase = base ? stripTrailingSlash(base) : null;
}

/**
 * Programmatically set the exact API root URL. Use this when the dashboard UI
 * is embedded as React components and the API is mounted somewhere other than
 * `<base>/api`, e.g. `/api/workbench`.
 */
export function setApiRoot(root: string | null): void {
  overrideRoot = root ? stripTrailingSlash(root) : null;
}

export function setRequestHeaders(headers: HeaderSource | null): void {
  overrideHeaders = headers;
}

/**
 * Resolve the current API base. Returns either an absolute URL with no
 * trailing slash (e.g. `http://127.0.0.1:54321`) or an empty string,
 * which signals "use relative `./api/*` paths".
 */
export function apiBase(): string {
  if (overrideBase !== null) return overrideBase;
  if (typeof window !== 'undefined' && window.__WORKBENCH_RUNTIME__?.apiBase) {
    return stripTrailingSlash(window.__WORKBENCH_RUNTIME__.apiBase);
  }
  return '';
}

export function apiRoot(): string {
  if (overrideRoot !== null) return overrideRoot;
  if (typeof window !== 'undefined' && window.__WORKBENCH_RUNTIME__?.apiRoot) {
    return stripTrailingSlash(window.__WORKBENCH_RUNTIME__.apiRoot);
  }
  return '';
}

export async function requestHeaders(): Promise<HeadersInit | undefined> {
  const source =
    overrideHeaders ??
    (typeof window !== 'undefined'
      ? window.__WORKBENCH_RUNTIME__?.headers
      : undefined);
  if (!source) return undefined;
  return typeof source === 'function' ? await source() : source;
}

/**
 * Build a fully-qualified URL for an API path like `/queues` or `queues`.
 * Falls back to `./api/<path>` for the relative-default case so the existing
 * `<base href>` mount-path logic keeps working.
 */
export function joinApi(path: string): string {
  const clean = path.replace(/^\/+/, '');
  const root = apiRoot();
  if (root) return `${root}/${clean}`;
  const base = apiBase();
  if (!base) return `./api/${clean}`;
  return `${base}/api/${clean}`;
}

/**
 * Build the URL for `/config` (sibling of `/api/*`, served by the same host).
 */
export function getConfigUrl(): string {
  const root = apiRoot();
  if (root) return `${root}/config`;
  const base = apiBase();
  if (!base) return './config';
  return `${base}/config`;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
