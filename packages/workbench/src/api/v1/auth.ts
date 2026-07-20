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
 * Runtime environment for the unconfigured-auth default. `{ nodeEnv }` carries a
 * readable `NODE_ENV` (its own value may be unset ⇒ development); `'unknown'`
 * means the runtime hid `process` (edge/serverless) so a non-production
 * environment cannot be confirmed — the default then fails closed.
 */
export type ControlEnv = { nodeEnv: string | undefined } | 'unknown';

/**
 * Resolve the control-API auth policy. A configured `token` becomes a leading
 * `apiKey()`; `strategies` (even the empty array) forces the walk. With neither
 * set the default is `open` only in a readable non-production environment; it is
 * `locked` (fail-closed) in production *and* when the environment is `'unknown'`,
 * so an edge runtime that can't read `NODE_ENV` never falls open by default.
 */
export function resolveControlAuth(
  config: ControlAuthConfig | undefined,
  env: ControlEnv,
): ControlAuth {
  const tokens = normalizeTokens(config?.token);
  const strategies = config?.strategies;
  if (tokens.length > 0 || strategies !== undefined) {
    const walk: AuthStrategy[] = [];
    if (tokens.length > 0) walk.push(apiKey(tokens));
    if (strategies !== undefined) walk.push(...strategies);
    return { mode: 'strategies', strategies: walk };
  }
  const locked = env === 'unknown' || env.nodeEnv === 'production';
  return locked ? { mode: 'locked' } : { mode: 'open' };
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
