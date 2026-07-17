import {
  type AuthChallenge,
  type AuthStrategy,
  authenticate,
  httpBasic,
} from '@openqueue/core';
import type { Middleware } from 'h3';
import type { WorkbenchOptions } from '../core/types';

/**
 * Normalize {@link WorkbenchOptions.auth} into an h3 middleware that runs the
 * auth walk, or `undefined` when auth is off. Credentials sugar becomes
 * `[httpBasic(...)]` with an exhausted-challenge `Basic realm="Workbench"` so
 * browsers show the native prompt; the strategy-array form uses a `Bearer`
 * challenge. A failure responds with a 401/403 `Unauthorized` text body.
 */
export function workbenchAuthMiddleware(
  auth: WorkbenchOptions['auth'],
): Middleware | undefined {
  if (auth === undefined) return undefined;
  const strategies: AuthStrategy[] = Array.isArray(auth)
    ? auth
    : [httpBasic(auth)];
  const challenges: AuthChallenge[] = Array.isArray(auth)
    ? [{ scheme: 'Bearer' }]
    : [{ scheme: 'Basic', parameters: { realm: 'Workbench' } }];

  return async (event, next) => {
    const result = await authenticate(event.req, strategies, { challenges });
    if (result.ok) return next();
    const headers = new Headers();
    for (const challenge of result.challenges) {
      headers.append('WWW-Authenticate', formatChallenge(challenge));
    }
    return new Response('Unauthorized', { status: result.status, headers });
  };
}

function formatChallenge(challenge: AuthChallenge): string {
  if (
    challenge.parameters === undefined ||
    Object.keys(challenge.parameters).length === 0
  ) {
    return challenge.scheme;
  }
  const rendered = Object.entries(challenge.parameters)
    .map(([key, value]) => `${key}="${escapeChallengeValue(value)}"`)
    .join(', ');
  return `${challenge.scheme} ${rendered}`;
}

function escapeChallengeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
