/**
 * Decode percent-encoded path param values, restoring Hono's behavior. rou3
 * (h3's router) delivers matched params raw, so a user-supplied id reaching a
 * path segment — a custom `jobId` used as a run id, a schedule id — arrives
 * percent-encoded (`my job` → `my%20job`) and would miss its lookup. Malformed
 * escapes (`decodeURIComponent('%E0%A4%A')` throws) fall back to the raw value
 * rather than failing the request, matching Hono's lenience.
 */
export function decodeParams(
  params: Record<string, string> | undefined,
): Record<string, string> {
  if (!params) return {};
  const decoded: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    try {
      decoded[key] = decodeURIComponent(value);
    } catch {
      decoded[key] = value;
    }
  }
  return decoded;
}
