import {
  type AuthChallenge,
  type AuthStrategy,
  apiKey,
  authenticate,
  type Principal,
} from '@openqueue/core/auth';

/** Auth inputs for the control API, sourced from `config.api`. */
export interface ControlAuthConfig {
  /** Bearer token(s) — sugar for a leading `apiKey()` strategy. */
  token?: string | string[];
  /** Ordered strategy walk. Runs after the token check when both are set. */
  strategies?: readonly AuthStrategy[];
}

/** Resolved control-API auth policy. */
export type ControlAuth =
  | { mode: 'strategies'; strategies: readonly AuthStrategy[] }
  | { mode: 'open' }
  | { mode: 'locked' };

/**
 * Resolve the control-API auth policy. A configured `token` becomes a leading
 * `apiKey()`; `strategies` (even the empty array) forces the walk; neither set
 * ⇒ `open` in development and `locked` (fail-closed) when
 * `NODE_ENV=production`.
 */
export function resolveControlAuth(
  config: ControlAuthConfig | undefined,
  nodeEnv: string | undefined,
): ControlAuth {
  const tokens = normalizeTokens(config?.token);
  const strategies = config?.strategies;
  if (tokens.length > 0 || strategies !== undefined) {
    const walk: AuthStrategy[] = [];
    if (tokens.length > 0) walk.push(apiKey(tokens));
    if (strategies !== undefined) walk.push(...strategies);
    return { mode: 'strategies', strategies: walk };
  }
  return nodeEnv === 'production' ? { mode: 'locked' } : { mode: 'open' };
}

/** Outcome of authorizing a control-API request. */
export type ControlAuthDecision =
  | { ok: true; principal?: Principal }
  | {
      ok: false;
      status: 401 | 403;
      code: string;
      message: string;
      challenges: AuthChallenge[];
    };

/**
 * Authorize one request against the resolved policy. `open` always passes with
 * no principal; `locked` always fails; `strategies` runs the ordered walk.
 */
export async function authorizeControlRequest(
  auth: ControlAuth,
  request: Request,
): Promise<ControlAuthDecision> {
  if (auth.mode === 'open') return { ok: true };
  if (auth.mode === 'locked') {
    return {
      ok: false,
      status: 401,
      code: 'unauthorized',
      message:
        'Control API is locked: set api.token or api.auth to enable access in production',
      challenges: [{ scheme: 'Bearer' }],
    };
  }
  const result = await authenticate(request, auth.strategies);
  if (result.ok) return { ok: true, principal: result.principal };
  return {
    ok: false,
    status: result.status,
    code: result.code,
    message: result.message,
    challenges: result.challenges,
  };
}

function normalizeTokens(token: string | string[] | undefined): string[] {
  if (token === undefined) return [];
  const list = Array.isArray(token) ? token : [token];
  return list.filter((value) => value.length > 0);
}
