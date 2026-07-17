import type { AuthStrategy } from '@openqueue/core';
import { describe, expect, it } from 'vitest';
import { authorizeControlRequest, resolveControlAuth } from '../auth';

function req(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set('authorization', authorization);
  return new Request('http://control.test/openqueue/v1/catalog', { headers });
}

describe('resolveControlAuth', () => {
  it('uses strategies mode when a token is configured', () => {
    expect(resolveControlAuth({ token: 't' }, 'production').mode).toBe(
      'strategies',
    );
  });

  it('uses strategies mode with an (even empty) strategies array', () => {
    expect(resolveControlAuth({ strategies: [] }, 'development').mode).toBe(
      'strategies',
    );
  });

  it('is open when unconfigured outside production', () => {
    expect(resolveControlAuth(undefined, 'development')).toEqual({
      mode: 'open',
    });
    expect(resolveControlAuth({}, 'development')).toEqual({ mode: 'open' });
  });

  it('is locked when unconfigured in production', () => {
    expect(resolveControlAuth(undefined, 'production')).toEqual({
      mode: 'locked',
    });
  });

  it('ignores empty tokens and locks in production', () => {
    expect(resolveControlAuth({ token: '' }, 'production')).toEqual({
      mode: 'locked',
    });
  });
});

describe('authorizeControlRequest', () => {
  const tokenAuth = resolveControlAuth({ token: 'secret' }, 'production');

  it('accepts a matching bearer token and returns the principal', async () => {
    const decision = await authorizeControlRequest(
      tokenAuth,
      req('Bearer secret'),
    );
    expect(decision.ok).toBe(true);
    if (decision.ok) {
      expect(decision.principal).toMatchObject({
        authenticator: 'api-key',
        principalType: 'service',
      });
    }
  });

  it('rejects a mismatched token with a 401 + Bearer challenge', async () => {
    const decision = await authorizeControlRequest(
      tokenAuth,
      req('Bearer wrong'),
    );
    expect(decision).toMatchObject({
      ok: false,
      status: 401,
      code: 'unauthorized',
      challenges: [{ scheme: 'Bearer' }],
    });
  });

  it('rejects a missing header', async () => {
    expect((await authorizeControlRequest(tokenAuth, req())).ok).toBe(false);
  });

  it('rejects a non-bearer scheme even with the right secret', async () => {
    expect(
      (await authorizeControlRequest(tokenAuth, req('Basic secret'))).ok,
    ).toBe(false);
  });

  it('accepts any of multiple configured tokens', async () => {
    const multi = resolveControlAuth({ token: ['a', 'b'] }, 'production');
    expect((await authorizeControlRequest(multi, req('Bearer b'))).ok).toBe(
      true,
    );
  });

  it('runs the token check before configured strategies', async () => {
    const throwing: AuthStrategy = () => {
      throw new Error('strategy should not run when the token matches');
    };
    const auth = resolveControlAuth(
      { token: 'secret', strategies: [throwing] },
      'production',
    );
    expect((await authorizeControlRequest(auth, req('Bearer secret'))).ok).toBe(
      true,
    );
  });

  it('always allows open mode with no principal', async () => {
    expect(await authorizeControlRequest({ mode: 'open' }, req())).toEqual({
      ok: true,
    });
  });

  it('always denies locked mode, and the message points at api.token', async () => {
    const decision = await authorizeControlRequest(
      { mode: 'locked' },
      req('Bearer secret'),
    );
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.status).toBe(401);
      expect(decision.message).toContain('api.token');
    }
  });

  it('fails closed on an empty strategies array', async () => {
    const auth = resolveControlAuth({ strategies: [] }, 'development');
    expect(
      (await authorizeControlRequest(auth, req('Bearer anything'))).ok,
    ).toBe(false);
  });
});
