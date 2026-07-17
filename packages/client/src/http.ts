import type { z } from 'zod';
import { type ClientErrorCode, OpenQueueClientError } from './errors';
import {
  CONTROL_PREFIX,
  errorResponseSchema,
  type WireErrorBody,
} from './wire';

export type TokenValue = string | (() => string | Promise<string>);

/**
 * How the client authenticates to the control API. `bearer` sends
 * `Authorization: Bearer <token>` (token resolved per request, so rotating
 * tokens work); `basic` sends `Authorization: Basic <base64(user:pass)>` for a
 * `httpBasic()`-protected API.
 */
export type ClientAuth =
  | { bearer: TokenValue }
  | { basic: { username: string; password: string } };

/**
 * The subset of `fetch` the client relies on. Looser than `typeof fetch` so a
 * custom implementation (tests, `app.fetch`) doesn't have to reproduce Node's
 * extra `preconnect` member.
 */
export type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface HttpOptions {
  host: string;
  auth?: ClientAuth;
  fetch?: FetchLike;
}

interface RequestArgs<T> {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  schema: z.ZodType<T>;
}

export interface Http {
  request<T>(args: RequestArgs<T>): Promise<{ status: number; data: T }>;
  requestOrStatus<T>(
    args: RequestArgs<T> & { expect: number[] },
  ): Promise<{ status: number; data?: T; error?: WireErrorBody }>;
}

export function createHttp(options: HttpOptions): Http {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const host = options.host.replace(/\/$/, '');

  const resolveAuthorization = async (): Promise<string | undefined> => {
    const auth = options.auth;
    if (auth === undefined) return undefined;
    if ('bearer' in auth) {
      const token =
        typeof auth.bearer === 'function' ? await auth.bearer() : auth.bearer;
      return `Bearer ${token}`;
    }
    const { username, password } = auth.basic;
    return `Basic ${btoa(`${username}:${password}`)}`;
  };

  const buildUrl = (
    path: string,
    query: RequestArgs<unknown>['query'],
  ): string => {
    const search = new URLSearchParams();
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) search.set(key, value);
      }
    }
    const qs = search.toString();
    return `${host}${CONTROL_PREFIX}${path}${qs ? `?${qs}` : ''}`;
  };

  const send = async (
    args: RequestArgs<unknown>,
  ): Promise<{ status: number; json: unknown }> => {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const authorization = await resolveAuthorization();
    if (authorization !== undefined) headers.Authorization = authorization;
    if (args.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await fetchImpl(buildUrl(args.path, args.query), {
        method: args.method,
        headers,
        body: args.body === undefined ? undefined : JSON.stringify(args.body),
      });
    } catch (cause) {
      throw new OpenQueueClientError(
        'network_error',
        `${args.method} ${args.path} could not reach the worker`,
        { cause },
      );
    }
    const json = await response.json().catch(() => undefined);
    return { status: response.status, json };
  };

  const parseError = (json: unknown): WireErrorBody | undefined => {
    const parsed = errorResponseSchema.safeParse(json);
    return parsed.success ? parsed.data.error : undefined;
  };

  const fail = (
    args: RequestArgs<unknown>,
    status: number,
    json: unknown,
  ): OpenQueueClientError => {
    const error = parseError(json);
    const message =
      error?.message ??
      `${args.method} ${args.path} failed with status ${status}`;
    return new OpenQueueClientError(statusCode(status), message, {
      status,
      details: json,
    });
  };

  const invalidResponse = (
    args: RequestArgs<unknown>,
    status: number,
    json: unknown,
    cause: unknown,
  ): OpenQueueClientError =>
    new OpenQueueClientError(
      'invalid_response',
      `${args.method} ${args.path} returned an unexpected body`,
      { status, details: json, cause },
    );

  return {
    request: async (args) => {
      const { status, json } = await send(args);
      if (status < 200 || status >= 300) throw fail(args, status, json);
      const parsed = args.schema.safeParse(json);
      if (!parsed.success)
        throw invalidResponse(args, status, json, parsed.error);
      return { status, data: parsed.data };
    },
    requestOrStatus: async (args) => {
      const { status, json } = await send(args);
      if (!args.expect.includes(status)) throw fail(args, status, json);
      const parsed = args.schema.safeParse(json);
      if (parsed.success) return { status, data: parsed.data };
      if (status >= 200 && status < 300) {
        throw invalidResponse(args, status, json, parsed.error);
      }
      return { status, error: parseError(json) };
    },
  };
}

function statusCode(status: number): ClientErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server_error';
  return 'invalid_request';
}
