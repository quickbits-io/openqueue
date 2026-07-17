import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  exportJWK,
  type GenerateKeyPairResult,
  generateKeyPair,
  SignJWT,
} from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyOidc } from '../auth';

const KID = 'test-key';

let server: Server;
let base: string;
let keys: GenerateKeyPairResult;

async function sign(
  overrides: {
    issuer?: string;
    audience?: string;
    subject?: string;
    extra?: Record<string, unknown>;
  } = {},
): Promise<string> {
  return new SignJWT({ ...overrides.extra })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setIssuedAt()
    .setIssuer(overrides.issuer ?? base)
    .setAudience(overrides.audience ?? 'openqueue')
    .setSubject(overrides.subject ?? 'worker')
    .setExpirationTime('2h')
    .sign(keys.privateKey);
}

beforeAll(async () => {
  keys = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: KID,
    alg: 'RS256',
    use: 'sig',
  };

  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/broken/.well-known/openid-configuration') {
      json(500, { error: 'boom' });
      return;
    }
    if (req.url === '/.well-known/openid-configuration') {
      json(200, { issuer: base, jwks_uri: `${base}/jwks` });
      return;
    }
    if (req.url === '/jwks') {
      json(200, { keys: [publicJwk] });
      return;
    }
    json(404, { error: 'not found' });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('expected a TCP address');
      }
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

describe('verifyOidc', () => {
  it('accepts a token signed by the discovered JWKS', async () => {
    const token = await sign({ extra: { org: 't1' } });
    const result = await verifyOidc(token, {
      issuer: base,
      audience: 'openqueue',
      tenantClaim: 'org',
    });
    expect(result).toMatchObject({
      ok: true,
      principal: {
        authenticator: 'oidc',
        principalId: `${base}:worker`,
        principalType: 'service',
        tenantId: 't1',
        attributes: { org: 't1' },
      },
    });
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await sign({ audience: 'someone-else' });
    const result = await verifyOidc(token, {
      issuer: base,
      audience: 'openqueue',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a token that fails subject matchers', async () => {
    const token = await sign({ subject: 'service:api:prod' });
    const result = await verifyOidc(token, {
      issuer: base,
      audience: 'openqueue',
      subjects: ['service:worker:*'],
    });
    expect(result.ok).toBe(false);
  });

  it('skips (returns not-ok) when discovery fails', async () => {
    const token = await sign();
    const result = await verifyOidc(token, {
      issuer: 'https://broken.test',
      audience: 'openqueue',
      discoveryUrl: `${base}/broken/.well-known/openid-configuration`,
    });
    expect(result.ok).toBe(false);
  });
});
