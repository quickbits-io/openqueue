import type { AuthChallenge, Principal } from '@openqueue/core';
import { H3, type H3Event } from 'h3';
import { decodeParams } from '../decode-params';
import type { HandlerInput, RouteDef } from '../handlers';
import { authorizeControlRequest, resolveControlAuth } from './auth';
import { buildControlRouteTable, type ControlApiOptions } from './routes';
import { controlError } from './serialize';

/**
 * Assemble the `/openqueue/v1` control API as an h3 app. h3 always runs global
 * middleware before route lookup — so instead of registering `GET /health`
 * ahead of the auth middleware, the middleware bypasses `/health` explicitly and
 * runs the resolved {@link resolveControlAuth} walk on everything else. This is
 * fail-closed: an unauthenticated request to *any* other path (including unknown
 * ones) is rejected before route matching. The verified {@link Principal} is
 * handed to handlers through a request-scoped `WeakMap` — no `event.context`
 * augmentation, which a published library must not impose on its host.
 *
 * Under `.mount('/openqueue/v1', …)` h3 strips the base from `event.url.pathname`
 * while this middleware runs, so the `=== '/health'` check and the principal
 * `WeakMap` (keyed on the single per-request event) work identically mounted and
 * standalone.
 */
export function buildControlApp(options: ControlApiOptions): H3 {
  const app = new H3();
  const routes = buildControlRouteTable(options);
  const auth = resolveControlAuth(options.auth, process.env.NODE_ENV);
  const principals = new WeakMap<H3Event, Principal>();

  app.use(async (event, next) => {
    if (event.url.pathname === '/health') return next();

    const decision = await authorizeControlRequest(auth, event.req);
    if (!decision.ok) {
      console.warn(
        `[openqueue] control API auth failed (${decision.status}) ${event.req.method} ${event.url.pathname} — ${decision.code}`,
      );
      const headers = new Headers({ 'Content-Type': 'application/json' });
      for (const challenge of decision.challenges) {
        headers.append('WWW-Authenticate', formatChallenge(challenge));
      }
      return new Response(
        JSON.stringify({
          error: { code: decision.code, message: decision.message },
        }),
        { status: decision.status, headers },
      );
    }
    if (decision.principal !== undefined) {
      principals.set(event, decision.principal);
    }
    return next();
  });

  for (const route of routes) {
    app.on(route.method, route.path, (event) =>
      dispatch(route, event, principals.get(event)),
    );
  }

  // Authenticated requests to an unregistered path fall through to this
  // wildcard, which answers with the wire 404 envelope instead of h3's default
  // HTTPError body. The auth middleware still runs first (global middleware
  // precedes route matching in h3), so an unauthenticated unknown path is
  // rejected 401 before reaching here — the fail-closed order is preserved.
  app.all('/**', (event) => {
    const result = controlError(
      'not_found',
      `No route for ${event.req.method} ${event.url.pathname}`,
    );
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return app;
}

async function dispatch(
  route: RouteDef,
  event: H3Event,
  principal: Principal | undefined,
): Promise<Response> {
  const input: HandlerInput = {
    params: decodeParams(event.context.params),
    query: Object.fromEntries(event.url.searchParams),
    body: route.meta?.body
      ? await event.req.json().catch(() => undefined)
      : undefined,
    principal,
  };
  const result = await route.handler(input);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  });
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
