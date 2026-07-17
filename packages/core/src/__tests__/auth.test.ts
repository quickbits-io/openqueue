import { generateKeyPair, SignJWT, UnsecuredJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  type AuthStrategy,
  apiKey,
  authenticate,
  extractBearerToken,
  ForbiddenError,
  localDev,
  none,
  type Principal,
  UnauthenticatedError,
  verifyApiKey,
  verifyHttpBasic,
  verifyJwtHmac,
} from '../auth';

const HMAC_SECRET = 'super-secret-signing-key-for-tests-000';

function request(
  url = 'https://api.example.com/openqueue/v1/runs',
  authorization?: string,
): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request(url, { headers });
}

function basicHeader(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function principalFor(id: string): AuthStrategy {
  return () => ({
    authenticator: 'test',
    principalId: id,
    principalType: 'service',
    attributes: {},
  });
}

async function signHmac(
  claims: Record<string, unknown>,
  overrides: {
    algorithm?: 'HS256' | 'HS384' | 'HS512';
    issuer?: string;
    audience?: string;
    subject?: string;
    expiresAt?: number;
  } = {},
): Promise<string> {
  const builder = new SignJWT(claims)
    .setProtectedHeader({ alg: overrides.algorithm ?? 'HS256' })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? 'https://issuer.test')
    .setAudience(overrides.audience ?? 'openqueue')
    .setExpirationTime(overrides.expiresAt ?? '2h');
  if (overrides.subject !== undefined) builder.setSubject(overrides.subject);
  return builder.sign(new TextEncoder().encode(HMAC_SECRET));
}

describe('authenticate — walk', () => {
  it('returns the first non-null principal and stops', async () => {
    let secondCalled = false;
    const result = await authenticate(request(), [
      principalFor('winner'),
      () => {
        secondCalled = true;
        return null;
      },
    ]);
    expect(result).toEqual({
      ok: true,
      principal: {
        authenticator: 'test',
        principalId: 'winner',
        principalType: 'service',
        attributes: {},
      },
    });
    expect(secondCalled).toBe(false);
  });

  it('skips null/undefined strategies and accepts a later one', async () => {
    const result = await authenticate(request(), [
      () => null,
      () => undefined,
      principalFor('later'),
    ]);
    expect(result.ok && result.principal.principalId).toBe('later');
  });

  it('fails closed with a 401 + Bearer challenge on an empty list', async () => {
    const result = await authenticate(request(), []);
    expect(result).toEqual({
      ok: false,
      status: 401,
      code: 'unauthorized',
      message: 'Authentication is required.',
      challenges: [{ scheme: 'Bearer' }],
    });
  });

  it('honors custom exhausted challenges', async () => {
    const result = await authenticate(request(), [() => null], {
      challenges: [{ scheme: 'Basic', parameters: { realm: 'Workbench' } }],
    });
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      challenges: [{ scheme: 'Basic', parameters: { realm: 'Workbench' } }],
    });
  });

  it('maps UnauthenticatedError to a 401 with its code/message/challenges', async () => {
    const result = await authenticate(request(), [
      () => {
        throw new UnauthenticatedError({
          code: 'token_expired',
          message: 'expired',
          challenges: [{ scheme: 'Bearer' }],
        });
      },
    ]);
    expect(result).toEqual({
      ok: false,
      status: 401,
      code: 'token_expired',
      message: 'expired',
      challenges: [{ scheme: 'Bearer' }],
    });
  });

  it('maps ForbiddenError to a 403 with no challenges', async () => {
    const result = await authenticate(request(), [
      () => {
        throw new ForbiddenError({ code: 'wrong_tenant', message: 'nope' });
      },
    ]);
    expect(result).toEqual({
      ok: false,
      status: 403,
      code: 'wrong_tenant',
      message: 'nope',
      challenges: [],
    });
  });

  it('short-circuits: a thrown UnauthenticatedError stops later strategies', async () => {
    let laterCalled = false;
    const result = await authenticate(request(), [
      () => {
        throw new UnauthenticatedError({ code: 'nope' });
      },
      () => {
        laterCalled = true;
        return null;
      },
    ]);
    expect(result).toMatchObject({ ok: false, status: 401, code: 'nope' });
    expect(laterCalled).toBe(false);
  });

  it('propagates non-auth errors', async () => {
    await expect(
      authenticate(request(), [
        () => {
          throw new Error('database down');
        },
      ]),
    ).rejects.toThrow('database down');
  });

  it('accepts a single strategy (not wrapped in an array)', async () => {
    const result = await authenticate(request(), principalFor('single'));
    expect(result.ok && result.principal.principalId).toBe('single');
  });
});

describe('extractBearerToken', () => {
  it('extracts a bearer token case-insensitively', () => {
    expect(extractBearerToken('Bearer abc')).toBe('abc');
    expect(extractBearerToken('bearer   xyz  ')).toBe('xyz');
  });

  it('returns null for missing, wrong scheme, or empty value', () => {
    expect(extractBearerToken(null)).toBeNull();
    expect(extractBearerToken('Basic abc')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('apiKey', () => {
  it('accepts a matching token and defaults the principal', () => {
    const result = verifyApiKey('Bearer tok', { token: 'tok' });
    expect(result).toEqual({
      ok: true,
      principal: {
        authenticator: 'api-key',
        principalId: 'api-key',
        principalType: 'service',
        attributes: {},
      },
    });
  });

  it('rejects a mismatched or missing token', () => {
    expect(verifyApiKey('Bearer nope', { token: 'tok' }).ok).toBe(false);
    expect(verifyApiKey(null, { token: 'tok' }).ok).toBe(false);
    expect(verifyApiKey('Basic tok', { token: 'tok' }).ok).toBe(false);
  });

  it('accepts any of multiple configured tokens', () => {
    expect(verifyApiKey('Bearer b', { token: ['a', 'b'] }).ok).toBe(true);
  });

  it('applies principal overrides (incl. tenantId)', () => {
    const result = verifyApiKey('Bearer tok', {
      token: 'tok',
      principal: {
        principalId: 'svc-1',
        principalType: 'user',
        tenantId: 't1',
      },
    });
    expect(result).toMatchObject({
      ok: true,
      principal: {
        principalId: 'svc-1',
        principalType: 'user',
        tenantId: 't1',
      },
    });
  });

  it('works as a strategy over a Request', async () => {
    const strategy = apiKey({ token: 'tok', principal: { tenantId: 't1' } });
    expect(await strategy(request(undefined, 'Bearer tok'))).toMatchObject({
      tenantId: 't1',
    });
    expect(await strategy(request(undefined, 'Bearer no'))).toBeNull();
  });
});

describe('httpBasic', () => {
  it('accepts matching credentials', () => {
    const result = verifyHttpBasic(basicHeader('admin', 'pw'), {
      username: 'admin',
      password: 'pw',
    });
    expect(result).toMatchObject({
      ok: true,
      principal: {
        authenticator: 'http-basic',
        principalId: 'admin',
        principalType: 'user',
      },
    });
  });

  it('rejects a wrong password, wrong user, bad scheme, or malformed header', () => {
    const opts = { username: 'admin', password: 'pw' };
    expect(verifyHttpBasic(basicHeader('admin', 'wrong'), opts).ok).toBe(false);
    expect(verifyHttpBasic(basicHeader('other', 'pw'), opts).ok).toBe(false);
    expect(verifyHttpBasic('Bearer x', opts).ok).toBe(false);
    expect(verifyHttpBasic(`Basic ${btoa('no-colon')}`, opts).ok).toBe(false);
    expect(verifyHttpBasic(null, opts).ok).toBe(false);
  });

  it('carries a configured tenantId onto the principal', () => {
    const result = verifyHttpBasic(basicHeader('admin', 'pw'), {
      username: 'admin',
      password: 'pw',
      tenantId: 't1',
    });
    expect(result).toMatchObject({ ok: true, principal: { tenantId: 't1' } });
  });
});

describe('jwtHmac', () => {
  const base = {
    algorithm: 'HS256' as const,
    secret: HMAC_SECRET,
    issuer: 'https://issuer.test',
    audience: 'openqueue',
  };

  it('accepts a valid token and projects non-standard claims', async () => {
    const token = await signHmac(
      { scope: 'jobs:write', org: 't1' },
      { subject: 'worker' },
    );
    const result = await verifyJwtHmac(token, base);
    expect(result).toMatchObject({
      ok: true,
      principal: {
        authenticator: 'jwt-hmac',
        principalId: 'https://issuer.test:worker',
        principalType: 'service',
        issuer: 'https://issuer.test',
        subject: 'worker',
        attributes: { scope: 'jobs:write', org: 't1' },
      },
    });
  });

  it('reads tenantClaim into principal.tenantId', async () => {
    const token = await signHmac({ org: 'acme' }, { subject: 'worker' });
    const result = await verifyJwtHmac(token, { ...base, tenantClaim: 'org' });
    expect(result).toMatchObject({ ok: true, principal: { tenantId: 'acme' } });
  });

  it('rejects a token with no subject', async () => {
    const token = await signHmac({});
    expect((await verifyJwtHmac(token, base)).ok).toBe(false);
  });

  it('rejects an expired token', async () => {
    const token = await signHmac(
      {},
      { subject: 'worker', expiresAt: Math.floor(Date.now() / 1000) - 3600 },
    );
    expect((await verifyJwtHmac(token, base)).ok).toBe(false);
  });

  it('rejects wrong issuer, audience, and algorithm', async () => {
    const wrongIssuer = await signHmac(
      {},
      { subject: 'w', issuer: 'https://evil.test' },
    );
    expect((await verifyJwtHmac(wrongIssuer, base)).ok).toBe(false);

    const wrongAudience = await signHmac(
      {},
      { subject: 'w', audience: 'someone-else' },
    );
    expect((await verifyJwtHmac(wrongAudience, base)).ok).toBe(false);

    const wrongAlg = await signHmac({}, { subject: 'w', algorithm: 'HS512' });
    expect((await verifyJwtHmac(wrongAlg, base)).ok).toBe(false);
  });

  it('enforces subject wildcard matchers', async () => {
    const token = await signHmac({}, { subject: 'service:worker:prod' });
    expect(
      (await verifyJwtHmac(token, { ...base, subjects: ['service:worker:*'] }))
        .ok,
    ).toBe(true);
    expect(
      (await verifyJwtHmac(token, { ...base, subjects: ['service:api:*'] })).ok,
    ).toBe(false);
  });

  it('enforces claim membership matchers (string and array claims)', async () => {
    const token = await signHmac(
      { roles: ['ops', 'admin'], region: 'eu' },
      { subject: 'worker' },
    );
    expect(
      (await verifyJwtHmac(token, { ...base, claims: { roles: ['admin'] } }))
        .ok,
    ).toBe(true);
    expect(
      (await verifyJwtHmac(token, { ...base, claims: { region: ['eu'] } })).ok,
    ).toBe(true);
    expect(
      (await verifyJwtHmac(token, { ...base, claims: { roles: ['none'] } })).ok,
    ).toBe(false);
    expect(
      (await verifyJwtHmac(token, { ...base, claims: { missing: ['x'] } })).ok,
    ).toBe(false);
  });

  it('rejects an unsigned alg:none token', async () => {
    const token = new UnsecuredJWT({ org: 't1' })
      .setSubject('worker')
      .setIssuer('https://issuer.test')
      .setAudience('openqueue')
      .encode();
    expect((await verifyJwtHmac(token, base)).ok).toBe(false);
  });

  it('rejects an RS256-signed token under HMAC options (algorithm confusion)', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const token = await new SignJWT({ org: 't1' })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('worker')
      .setIssuer('https://issuer.test')
      .setAudience('openqueue')
      .setExpirationTime('2h')
      .sign(privateKey);
    expect((await verifyJwtHmac(token, base)).ok).toBe(false);
  });

  it('honors clockSkewSeconds at the expiry boundary', async () => {
    const now = Math.floor(Date.now() / 1000);
    const withinSkew = await signHmac(
      {},
      { subject: 'worker', expiresAt: now - 10 },
    );
    expect(
      (await verifyJwtHmac(withinSkew, { ...base, clockSkewSeconds: 30 })).ok,
    ).toBe(true);
    const outsideSkew = await signHmac(
      {},
      { subject: 'worker', expiresAt: now - 60 },
    );
    expect(
      (await verifyJwtHmac(outsideSkew, { ...base, clockSkewSeconds: 30 })).ok,
    ).toBe(false);
  });

  it('accepts a member of an audience array and rejects a non-member', async () => {
    const member = await signHmac({}, { subject: 'worker', audience: 'b' });
    expect(
      (await verifyJwtHmac(member, { ...base, audience: ['a', 'b'] })).ok,
    ).toBe(true);
    const nonMember = await signHmac({}, { subject: 'worker', audience: 'c' });
    expect(
      (await verifyJwtHmac(nonMember, { ...base, audience: ['a', 'b'] })).ok,
    ).toBe(false);
  });

  it('rejects a token whose configured tenant claim is missing or not a string (fail-closed)', async () => {
    // Fail-closed: when tenantClaim is configured, a token whose claim is a
    // non-string OR absent must be rejected — never accepted as a tenant-less
    // super-principal that can see every tenant.
    const nonString = await signHmac({ org: 12345 }, { subject: 'worker' });
    expect(
      (await verifyJwtHmac(nonString, { ...base, tenantClaim: 'org' })).ok,
    ).toBe(false);

    const missing = await signHmac({}, { subject: 'worker' });
    expect(
      (await verifyJwtHmac(missing, { ...base, tenantClaim: 'org' })).ok,
    ).toBe(false);
  });
});

describe('localDev', () => {
  const strategy = localDev();

  const accepts = (host: string) =>
    strategy(new Request(`http://${host}/x`)) as Principal | null;

  it('accepts loopback hosts', () => {
    for (const host of [
      'localhost',
      'localhost:8090',
      '[::1]',
      '127.0.0.1',
      '127.0.0.5',
      'foo.localhost',
    ]) {
      expect(accepts(host)).toMatchObject({ principalType: 'local-dev' });
    }
  });

  it('rejects public hosts and 0.0.0.0', () => {
    for (const host of [
      '0.0.0.0',
      'example.com',
      '10.0.0.1',
      'notlocalhost.com',
    ]) {
      expect(accepts(host)).toBeNull();
    }
  });
});

describe('none', () => {
  it('accepts anonymously', () => {
    expect(none()(request())).toEqual({
      authenticator: 'none',
      principalId: 'anonymous',
      principalType: 'anonymous',
      attributes: {},
    });
  });
});
