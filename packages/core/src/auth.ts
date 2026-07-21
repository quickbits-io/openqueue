/**
 * Pluggable HTTP authentication for the control API and dashboard.
 *
 * The primitive is an ordered walk of {@link AuthStrategy} functions (ported
 * from eve's `routeAuth`): the first strategy to return a {@link Principal}
 * wins, `null`/`undefined` skips to the next, a thrown
 * {@link UnauthenticatedError}/{@link ForbiddenError} short-circuits, and an
 * exhausted list (including the empty array) fails closed with a 401.
 *
 * The module is import-clean on purpose: it imports only `jose` and web
 * standards (no other core module at runtime), so a future `@openqueue/core/auth`
 * subpath can ship to Cloudflare Workers/Deno unchanged.
 */

import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import type { RunPrincipal } from './types';

/**
 * A verified caller. Extends {@link RunPrincipal} with the identity detail the
 * control API does not stamp onto runs (`issuer`, `subject`, `attributes`).
 */
export interface Principal extends RunPrincipal {
  issuer?: string;
  subject?: string;
  /** Serializable projection of non-standard string claims. NOT stamped onto runs. */
  attributes: Record<string, string | string[]>;
}

/**
 * A single authentication attempt. Returns a {@link Principal} to accept and
 * halt the walk, `null`/`undefined` to skip to the next strategy. Throw
 * {@link UnauthenticatedError}/{@link ForbiddenError} to reject explicitly.
 */
export type AuthStrategy = (
  request: Request,
) => Principal | null | undefined | Promise<Principal | null | undefined>;

/** One `WWW-Authenticate` challenge entry. */
export interface AuthChallenge {
  scheme: 'Basic' | 'Bearer';
  parameters?: Record<string, string>;
}

/** Options accepted by the auth error classes. */
export interface AuthDenialOptions {
  code?: string;
  message?: string;
  challenges?: AuthChallenge[];
}

/**
 * Thrown by a strategy to reject a request with a 401. Caught by
 * {@link authenticate}, which maps it to an `AuthResult`.
 */
export class UnauthenticatedError extends Error {
  readonly code: string;
  readonly challenges: AuthChallenge[];

  constructor(options: AuthDenialOptions = {}) {
    super(options.message ?? 'Authentication is required.');
    this.name = 'UnauthenticatedError';
    this.code = options.code ?? 'unauthorized';
    this.challenges = options.challenges ?? [];
  }
}

/**
 * Thrown by a strategy to reject a request with a 403 (authenticated but not
 * allowed). Caught by {@link authenticate}.
 */
export class ForbiddenError extends Error {
  readonly code: string;

  constructor(options: Omit<AuthDenialOptions, 'challenges'> = {}) {
    super(options.message ?? 'Forbidden.');
    this.name = 'ForbiddenError';
    this.code = options.code ?? 'forbidden';
  }
}

/** Outcome of an {@link authenticate} walk. */
export type AuthResult =
  | { ok: true; principal: Principal }
  | {
      ok: false;
      status: 401 | 403;
      code: string;
      message: string;
      challenges: AuthChallenge[];
    };

/**
 * Walk `strategies` in order against `request`. First {@link Principal} wins;
 * `null`/`undefined` skips; a thrown {@link UnauthenticatedError}/
 * {@link ForbiddenError} short-circuits to 401/403; an exhausted list
 * (including the empty array) fails closed with a 401 carrying
 * `options.challenges` (default `[{ scheme: 'Bearer' }]`). Non-auth errors
 * propagate.
 */
export async function authenticate(
  request: Request,
  strategies: AuthStrategy | readonly AuthStrategy[],
  options: { challenges?: AuthChallenge[] } = {},
): Promise<AuthResult> {
  const list = normalizeStrategies(strategies);
  try {
    for (const strategy of list) {
      const principal = await strategy(request);
      if (principal) return { ok: true, principal };
    }
  } catch (error) {
    if (error instanceof UnauthenticatedError) {
      return {
        ok: false,
        status: 401,
        code: error.code,
        message: error.message,
        challenges: error.challenges,
      };
    }
    if (error instanceof ForbiddenError) {
      return {
        ok: false,
        status: 403,
        code: error.code,
        message: error.message,
        challenges: [],
      };
    }
    throw error;
  }
  return {
    ok: false,
    status: 401,
    code: 'unauthorized',
    message: 'Authentication is required.',
    challenges: options.challenges ?? [{ scheme: 'Bearer' }],
  };
}

function normalizeStrategies(
  strategies: AuthStrategy | readonly AuthStrategy[],
): readonly AuthStrategy[] {
  return typeof strategies === 'function' ? [strategies] : strategies;
}

// ---------------------------------------------------------------------------
// Bearer extraction + verifier result
// ---------------------------------------------------------------------------

/**
 * Extract the token from an `Authorization: Bearer <token>` header. Returns
 * `null` when the header is missing, the scheme is not `Bearer`, or the value
 * is empty.
 */
export function extractBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

/** Result of a pure verifier — no failure detail so callers cannot leak it. */
export type VerifyResult = { ok: true; principal: Principal } | { ok: false };

// ---------------------------------------------------------------------------
// API key (bearer token)
// ---------------------------------------------------------------------------

export interface ApiKeyOptions {
  token: string | readonly string[];
  /**
   * Defaults: `{ principalId: 'api-key', principalType: 'service' }`. Distinct
   * keys per tenant = multiple `apiKey()` entries in the walk.
   */
  principal?: {
    principalId?: string;
    principalType?: string;
    tenantId?: string;
  };
}

/** An {@link AuthStrategy} that accepts a configured bearer token. */
export function apiKey(
  options: string | readonly string[] | ApiKeyOptions,
): AuthStrategy {
  const resolved = toApiKeyOptions(options);
  return (request) => {
    const result = verifyApiKey(request.headers.get('authorization'), resolved);
    return result.ok ? result.principal : null;
  };
}

/** Verify a bearer token against configured API key(s). */
export function verifyApiKey(
  header: string | null,
  options: ApiKeyOptions,
): VerifyResult {
  const token = extractBearerToken(header);
  if (token === null) return { ok: false };
  const tokens =
    typeof options.token === 'string' ? [options.token] : options.token;
  if (!tokens.some((candidate) => constantTimeEquals(candidate, token))) {
    return { ok: false };
  }
  const principal: Principal = {
    authenticator: 'api-key',
    principalId: options.principal?.principalId ?? 'api-key',
    principalType: options.principal?.principalType ?? 'service',
    attributes: {},
  };
  if (options.principal?.tenantId !== undefined) {
    principal.tenantId = options.principal.tenantId;
  }
  return { ok: true, principal };
}

function toApiKeyOptions(
  options: string | readonly string[] | ApiKeyOptions,
): ApiKeyOptions {
  return isApiKeyOptions(options) ? options : { token: options };
}

function isApiKeyOptions(
  options: string | readonly string[] | ApiKeyOptions,
): options is ApiKeyOptions {
  return typeof options === 'object' && !Array.isArray(options);
}

// ---------------------------------------------------------------------------
// HTTP Basic
// ---------------------------------------------------------------------------

export interface HttpBasicOptions {
  username: string;
  password: string;
  tenantId?: string;
}

/** An {@link AuthStrategy} that verifies HTTP Basic credentials. */
export function httpBasic(options: HttpBasicOptions): AuthStrategy {
  return (request) => {
    const result = verifyHttpBasic(
      request.headers.get('authorization'),
      options,
    );
    return result.ok ? result.principal : null;
  };
}

/** Verify an `Authorization: Basic <base64>` credential. */
export function verifyHttpBasic(
  header: string | null,
  options: HttpBasicOptions,
): VerifyResult {
  const credentials = parseBasicHeader(header);
  if (credentials === null) return { ok: false };
  if (!constantTimeEquals(credentials.username, options.username)) {
    return { ok: false };
  }
  if (!constantTimeEquals(credentials.password, options.password)) {
    return { ok: false };
  }
  const principal: Principal = {
    authenticator: 'http-basic',
    principalId: options.username,
    principalType: 'user',
    attributes: {},
  };
  if (options.tenantId !== undefined) principal.tenantId = options.tenantId;
  return { ok: true, principal };
}

function parseBasicHeader(
  header: string | null,
): { username: string; password: string } | null {
  if (header === null) return null;
  const match = /^Basic\s+(.+)$/i.exec(header);
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeBase64ToString(encoded);
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator === -1) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

// ---------------------------------------------------------------------------
// JWT claim matchers (shared by jwtHmac + oidc)
// ---------------------------------------------------------------------------

export interface JwtClaimMatchers {
  /** Claim used as the principal subject. Defaults to `sub`. */
  subjectClaim?: string;
  /** AWS IAM-style `*` whole-string wildcards against the principal subject. */
  subjects?: readonly string[];
  /** Each named claim must contain at least one listed value. */
  claims?: Readonly<Record<string, readonly string[]>>;
}

// ---------------------------------------------------------------------------
// JWT (HMAC)
// ---------------------------------------------------------------------------

export interface JwtHmacOptions extends JwtClaimMatchers {
  algorithm: 'HS256' | 'HS384' | 'HS512';
  secret: string;
  issuer: string;
  audience: string | readonly string[];
  /** Tolerance in seconds for `exp`/`nbf`. Defaults to 30. */
  clockSkewSeconds?: number;
  /**
   * Claim read into `principal.tenantId` (e.g. `'org_id'`). String claims only.
   * Fail-closed: when set, a token whose claim is missing or not a non-empty
   * string is rejected (`{ ok: false }`) rather than accepted as a tenant-less
   * super-principal that sees every tenant.
   */
  tenantClaim?: string;
}

/** An {@link AuthStrategy} that verifies an HMAC-signed bearer JWT. */
export function jwtHmac(options: JwtHmacOptions): AuthStrategy {
  return async (request) => {
    const token = extractBearerToken(request.headers.get('authorization'));
    const result = await verifyJwtHmac(token, options);
    return result.ok ? result.principal : null;
  };
}

/** Verify an HMAC-signed bearer JWT (token without the `Bearer ` prefix). */
export async function verifyJwtHmac(
  token: string | null,
  options: JwtHmacOptions,
): Promise<VerifyResult> {
  if (token === null || token.length === 0) return { ok: false };
  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(
      token,
      new TextEncoder().encode(options.secret),
      {
        algorithms: [options.algorithm],
        audience: toAudienceArray(options.audience),
        issuer: options.issuer,
        clockTolerance: options.clockSkewSeconds ?? 30,
      },
    );
    payload = verified.payload;
  } catch {
    return { ok: false };
  }
  return finishJwtVerification(payload, options, 'jwt-hmac');
}

// ---------------------------------------------------------------------------
// OIDC (JWKS)
// ---------------------------------------------------------------------------

export interface OidcOptions extends JwtClaimMatchers {
  issuer: string;
  audience: string | readonly string[];
  /** Defaults to `${issuer}/.well-known/openid-configuration` (trailing slash stripped). */
  discoveryUrl?: string;
  clockSkewSeconds?: number;
  /**
   * Claim read into `principal.tenantId` (e.g. `'org_id'`). String claims only.
   * Fail-closed: when set, a token whose claim is missing or not a non-empty
   * string is rejected (`{ ok: false }`) rather than accepted as a tenant-less
   * super-principal that sees every tenant.
   */
  tenantClaim?: string;
}

const oidcJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * An {@link AuthStrategy} that verifies an OIDC bearer token against the
 * issuer's JWKS (discovered once and cached). Discovery failure is logged and
 * skips (returns `null`) so the walk can fall through — it never accepts on a
 * misconfiguration.
 */
export function oidc(options: OidcOptions): AuthStrategy {
  return async (request) => {
    const token = extractBearerToken(request.headers.get('authorization'));
    const result = await verifyOidc(token, options);
    return result.ok ? result.principal : null;
  };
}

/** Verify an OIDC bearer token against the issuer's discovered JWKS. */
export async function verifyOidc(
  token: string | null,
  options: OidcOptions,
): Promise<VerifyResult> {
  if (token === null || token.length === 0) return { ok: false };
  const discoveryUrl =
    options.discoveryUrl ??
    `${options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;

  let jwks: ReturnType<typeof createRemoteJWKSet>;
  try {
    jwks = await getOidcJwks(discoveryUrl);
  } catch (error) {
    oidcJwksCache.delete(discoveryUrl);
    console.warn(
      `[openqueue] OIDC discovery failed for ${discoveryUrl}: ${
        error instanceof Error ? error.message : 'unknown error'
      }`,
    );
    return { ok: false };
  }

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, jwks, {
      audience: toAudienceArray(options.audience),
      issuer: options.issuer,
      clockTolerance: options.clockSkewSeconds ?? 30,
    });
    payload = verified.payload;
  } catch {
    return { ok: false };
  }
  return finishJwtVerification(payload, options, 'oidc');
}

async function getOidcJwks(
  discoveryUrl: string,
): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const existing = oidcJwksCache.get(discoveryUrl);
  if (existing !== undefined) return existing;
  const response = await fetch(discoveryUrl, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`discovery returned HTTP ${response.status}`);
  }
  const document: unknown = await response.json();
  const jwksUri = readJwksUri(document);
  if (jwksUri === undefined) {
    throw new Error('discovery document has no jwks_uri');
  }
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  oidcJwksCache.set(discoveryUrl, jwks);
  return jwks;
}

function readJwksUri(document: unknown): string | undefined {
  if (!isRecord(document)) return undefined;
  const value = document.jwks_uri;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Local dev + anonymous
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '[::1]']);
const LOOPBACK_IPV4_PREFIX = /^127\./;

/**
 * An {@link AuthStrategy} that authenticates loopback requests during local
 * development, keyed on the request URL's hostname (`localhost`, any
 * `*.localhost` subdomain, `127.0.0.0/8`, or `[::1]`). Every other request
 * skips (`null`).
 *
 * Caveat: this trusts the request URL's host, which reflects the `Host`
 * header. An origin that trusts an attacker-controlled `Host` (no CDN /
 * normalizing proxy) lets a spoofed `Host: localhost` reach `localDev()`.
 * Layer a real authenticator on such deployments.
 */
export function localDev(): AuthStrategy {
  return (request) =>
    isLoopbackRequest(request)
      ? {
          authenticator: 'local-dev',
          principalId: 'local-dev',
          principalType: 'local-dev',
          attributes: {},
        }
      : null;
}

/** Whether a request URL names a loopback host accepted by {@link localDev}. */
export function isLoopbackRequest(request: Request): boolean {
  let hostname: string;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return false;
  }
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  if (LOOPBACK_IPV4_PREFIX.test(hostname)) return true;
  // RFC 6761: the entire `.localhost` TLD resolves to loopback.
  if (hostname.endsWith('.localhost')) return true;
  return false;
}

/**
 * An {@link AuthStrategy} that accepts any request anonymously. Use it as the
 * final entry in a walk to opt routes into unauthenticated access.
 */
export function none(): AuthStrategy {
  return () => ({
    authenticator: 'none',
    principalId: 'anonymous',
    principalType: 'anonymous',
    attributes: {},
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const STANDARD_CLAIM_KEYS: ReadonlySet<string> = new Set([
  'aud',
  'exp',
  'iat',
  'iss',
  'jti',
  'nbf',
  'sub',
]);

function finishJwtVerification(
  payload: JWTPayload,
  options: JwtClaimMatchers & { issuer: string; tenantClaim?: string },
  authenticator: string,
): VerifyResult {
  const subject = payload[options.subjectClaim ?? 'sub'];
  if (typeof subject !== 'string' || subject.length === 0) {
    return { ok: false };
  }
  if (!matchersSatisfied(payload, options)) return { ok: false };

  let tenantId: string | undefined;
  if (options.tenantClaim !== undefined) {
    const value = payload[options.tenantClaim];
    // Fail closed: a configured tenant claim that is missing or non-string must
    // NOT yield a tenant-less super-principal that can see every tenant.
    if (typeof value !== 'string' || value.length === 0) return { ok: false };
    tenantId = value;
  }

  const issuer =
    typeof payload.iss === 'string' && payload.iss.length > 0
      ? payload.iss
      : options.issuer;
  const principal: Principal = {
    authenticator,
    principalId: `${issuer}:${subject}`,
    principalType: 'service',
    issuer,
    subject,
    attributes: projectAttributes(payload),
  };
  if (tenantId !== undefined) principal.tenantId = tenantId;
  return { ok: true, principal };
}

function matchersSatisfied(
  payload: JWTPayload,
  matchers: JwtClaimMatchers,
): boolean {
  const claims = normalizeStringClaims(payload);
  if (matchers.subjects !== undefined) {
    const value = payload[matchers.subjectClaim ?? 'sub'];
    const subject = typeof value === 'string' ? value : null;
    if (
      subject === null ||
      !matchers.subjects.some((pattern) => matchesWildcard(pattern, subject))
    ) {
      return false;
    }
  }
  if (matchers.claims === undefined) return true;
  return Object.entries(matchers.claims).every(([name, expected]) => {
    const value = claims[name];
    if (value === undefined) return false;
    if (typeof value === 'string') return expected.includes(value);
    return value.some((item) => expected.includes(item));
  });
}

function normalizeStringClaims(
  payload: JWTPayload,
): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (typeof value === 'string') {
      normalized[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const strings = value.filter(
        (item): item is string => typeof item === 'string',
      );
      if (strings.length === value.length) normalized[key] = strings;
    }
  }
  return normalized;
}

function projectAttributes(
  payload: JWTPayload,
): Record<string, string | string[]> {
  const attributes: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(normalizeStringClaims(payload))) {
    if (!STANDARD_CLAIM_KEYS.has(key)) attributes[key] = value;
  }
  return attributes;
}

/** AWS IAM-style whole-string wildcard match where `*` matches zero or more characters. */
function matchesWildcard(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  const escaped = pattern
    .replaceAll(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(value);
}

function toAudienceArray(audience: string | readonly string[]): string[] {
  return typeof audience === 'string' ? [audience] : [...audience];
}

/** Constant-time string compare; early length mismatch is not secret. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function decodeBase64ToString(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
