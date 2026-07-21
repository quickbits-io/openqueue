import type { Middleware } from 'h3';

const ALLOW_METHODS = 'GET,HEAD,PUT,POST,DELETE,PATCH';

/**
 * Hand-rolled CORS mirroring `hono/cors` defaults (`origin: '*'`): every
 * non-preflight response carries `Access-Control-Allow-Origin: *`, and an
 * `OPTIONS` preflight short-circuits with a bare `204 No Content` advertising the
 * allowed methods and echoing the requested headers.
 *
 * The header is applied by intercepting the downstream response rather than via
 * `event.res.headers`: h3 only merges prepared response headers onto 2xx
 * results, but Hono attached CORS to every response (including 4xx validation
 * errors), so intercepting keeps byte-parity across all status codes. Every
 * `/api/**` route returns a `Response`, so the mutation always lands.
 *
 * Byte-parity with the previous `hono/cors` output is a migration gate — the
 * request-header echo is split on commas (ignoring surrounding whitespace) and
 * rejoined with a bare `,`, and `Vary: Access-Control-Request-Headers` is
 * appended, exactly as Hono did.
 */
export const cors: Middleware = async (event, next) => {
  if (event.req.method === 'OPTIONS') {
    const headers = new Headers({ 'Access-Control-Allow-Origin': '*' });
    headers.set('Access-Control-Allow-Methods', ALLOW_METHODS);
    const requestHeaders = event.req.headers.get(
      'Access-Control-Request-Headers',
    );
    if (requestHeaders) {
      headers.set(
        'Access-Control-Allow-Headers',
        requestHeaders.split(/\s*,\s*/).join(','),
      );
      headers.append('Vary', 'Access-Control-Request-Headers');
    }
    return new Response(null, {
      status: 204,
      statusText: 'No Content',
      headers,
    });
  }

  const response = await next();
  if (response instanceof Response) {
    response.headers.set('Access-Control-Allow-Origin', '*');
  }
  return response;
};
