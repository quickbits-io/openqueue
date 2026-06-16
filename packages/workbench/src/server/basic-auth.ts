/**
 * Parse a `Basic` Authorization header and check it against the configured
 * credentials. Uses constant-time comparison to avoid leaking timing info
 * about which character mismatched.
 *
 * Returns `true` when credentials are valid, `false` otherwise. Both inputs
 * being undefined or empty count as a failed check — adapters should only
 * call this when `core.requiresAuth()` is true.
 */
export function checkBasicAuth(
  authHeader: string | undefined,
  username: string,
  password: string,
): boolean {
  if (!authHeader) return false;

  const [scheme, encoded] = authHeader.split(' ');
  if (scheme?.toLowerCase() !== 'basic' || !encoded) return false;

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf-8');
  } catch {
    return false;
  }

  const idx = decoded.indexOf(':');
  if (idx === -1) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  return safeEqual(user, username) && safeEqual(pass, password);
}

/**
 * Constant-time string compare. Returns false immediately on length mismatch
 * (length itself is not secret — protecting against timing leaks on the
 * character-by-character compare is what matters).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Standard 401 response body + header for an unauthenticated Basic auth
 * request. Adapters use this when `checkBasicAuth` returns false.
 */
export const BASIC_AUTH_CHALLENGE = {
  status: 401 as const,
  headers: { 'WWW-Authenticate': 'Basic realm="Workbench"' },
  body: 'Unauthorized',
};
