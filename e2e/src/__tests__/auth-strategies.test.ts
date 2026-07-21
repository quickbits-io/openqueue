import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClient } from '@openqueue/client';
import { apiKey, httpBasic, jwtHmac } from '@openqueue/sdk';
import { SignJWT } from 'jose';
import { clientErrorFrom, startTestWorker } from '../harness';

const poll = { pollIntervalMs: 50, maxAttempts: 400 } as const;

test('two-tenant apiKey: stamping, ownership, list scoping, spoof stripping', async () => {
  const w = await startTestWorker({
    api: {
      auth: [
        apiKey({ token: 't1-key', principal: { tenantId: 't1' } }),
        apiKey({ token: 't2-key', principal: { tenantId: 't2' } }),
      ],
    },
  });
  try {
    const t1 = createClient({ host: w.url, auth: { bearer: 't1-key' } });
    const t2 = createClient({ host: w.url, auth: { bearer: 't2-key' } });

    const { runId } = await t1.trigger('echo', { value: 'owned' });
    const run = await t1.runs.poll(runId, poll);
    expect(run.status).toBe('completed');
    expect(run.meta.enqueuedBy).toMatchObject({
      authenticator: 'api-key',
      principalType: 'service',
      tenantId: 't1',
    });

    // t2 cannot read or cancel t1's run
    expect((await clientErrorFrom(t2.runs.retrieve(runId))).code).toBe(
      'forbidden',
    );
    expect((await clientErrorFrom(t2.runs.cancel(runId))).code).toBe(
      'forbidden',
    );

    // lists are scoped both ways
    const t1List = await t1.runs.list();
    expect(t1List.data.some((r) => r.id === runId)).toBe(true);
    const t2List = await t2.runs.list();
    expect(t2List.data.some((r) => r.id === runId)).toBe(false);

    // schedule ownership mirrors run ownership
    const schedule = await t1.schedules.create({
      task: 'echo',
      input: { value: 'sched' },
      cron: '*/5 * * * *',
      deduplicationKey: `dk-${randomUUID()}`,
    });
    expect(
      (await clientErrorFrom(t2.schedules.retrieve(schedule.id))).code,
    ).toBe('forbidden');

    // a client-sent enqueuedBy spoof is stripped and re-stamped
    const spoof = await t1.trigger(
      'echo',
      { value: 'spoof' },
      {
        meta: {
          enqueuedBy: {
            authenticator: 'spoof',
            principalId: 'evil',
            principalType: 'service',
            tenantId: 't2',
          },
        },
      },
    );
    const spoofRun = await t1.runs.poll(spoof.runId, poll);
    expect(spoofRun.meta.enqueuedBy?.tenantId).toBe('t1');
  } finally {
    await w.close();
  }
});

test('ordered walk [httpBasic, apiKey]: basic + bearer accepted, garbage 401', async () => {
  const w = await startTestWorker({
    api: {
      auth: [
        httpBasic({ username: 'admin', password: 'pw' }),
        apiKey('bearer-key'),
      ],
    },
  });
  try {
    const basicClient = createClient({
      host: w.url,
      auth: { basic: { username: 'admin', password: 'pw' } },
    });
    const bearerClient = createClient({
      host: w.url,
      auth: { bearer: 'bearer-key' },
    });

    expect((await basicClient.catalog.read()).length).toBeGreaterThan(0);
    expect((await bearerClient.catalog.read()).length).toBeGreaterThan(0);

    const res = await fetch(`${w.url}/openqueue/v1/catalog`, {
      headers: { Authorization: 'Bearer garbage' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer');
  } finally {
    await w.close();
  }
});

test('api.auth: [] locks everything except /health (fail-closed)', async () => {
  const w = await startTestWorker({ api: { auth: [] } });
  try {
    const health = await fetch(`${w.url}/openqueue/v1/health`);
    expect(health.status).toBe(200);

    const catalog = await fetch(`${w.url}/openqueue/v1/catalog`, {
      headers: { Authorization: 'Bearer anything' },
    });
    expect(catalog.status).toBe(401);
  } finally {
    await w.close();
  }
});

test('api.token + api.auth combined: the token client authenticates', async () => {
  const w = await startTestWorker({
    api: {
      token: 'tok-combined',
      auth: [apiKey({ token: 'other-key', principal: { tenantId: 'z' } })],
    },
  });
  try {
    const client = createClient({
      host: w.url,
      auth: { bearer: 'tok-combined' },
    });
    expect((await client.catalog.read()).length).toBeGreaterThan(0);
  } finally {
    await w.close();
  }
});

test('jwtHmac with tenantClaim: valid accepted + stamped, expired/wrong-issuer 401', async () => {
  const secret = 'e2e-hmac-secret-000000000000000000000';
  const key = new TextEncoder().encode(secret);
  const w = await startTestWorker({
    api: {
      auth: [
        jwtHmac({
          algorithm: 'HS256',
          secret,
          issuer: 'https://e2e.test',
          audience: 'openqueue',
          tenantClaim: 'org',
        }),
      ],
    },
  });
  try {
    const valid = await new SignJWT({ org: 'acme' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('https://e2e.test')
      .setAudience('openqueue')
      .setSubject('worker')
      .setExpirationTime('2h')
      .sign(key);
    const client = createClient({ host: w.url, auth: { bearer: valid } });
    const { runId } = await client.trigger('echo', { value: 'jwt' });
    const run = await client.runs.poll(runId, poll);
    expect(run.meta.enqueuedBy).toMatchObject({
      authenticator: 'jwt-hmac',
      principalType: 'service',
      tenantId: 'acme',
    });

    const expired = await new SignJWT({ org: 'acme' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('https://e2e.test')
      .setAudience('openqueue')
      .setSubject('worker')
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);
    const expiredRes = await fetch(`${w.url}/openqueue/v1/catalog`, {
      headers: { Authorization: `Bearer ${expired}` },
    });
    expect(expiredRes.status).toBe(401);

    const wrongIssuer = await new SignJWT({ org: 'acme' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('https://evil.test')
      .setAudience('openqueue')
      .setSubject('worker')
      .setExpirationTime('2h')
      .sign(key);
    const wrongRes = await fetch(`${w.url}/openqueue/v1/catalog`, {
      headers: { Authorization: `Bearer ${wrongIssuer}` },
    });
    expect(wrongRes.status).toBe(401);

    // Fail-closed: a validly-signed token that omits the configured `org`
    // tenant claim must be rejected, not accepted as a super-principal.
    const missingClaim = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setIssuer('https://e2e.test')
      .setAudience('openqueue')
      .setSubject('worker')
      .setExpirationTime('2h')
      .sign(key);
    const missingClaimRes = await fetch(`${w.url}/openqueue/v1/catalog`, {
      headers: { Authorization: `Bearer ${missingClaim}` },
    });
    expect(missingClaimRes.status).toBe(401);
  } finally {
    await w.close();
  }
});

test('invalid list query over TCP returns 400 invalid_request with issues', async () => {
  const w = await startTestWorker();
  try {
    const res = await fetch(`${w.url}/openqueue/v1/runs?status=typo`, {
      headers: { Authorization: `Bearer ${w.token}` },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.issues.length).toBeGreaterThan(0);
  } finally {
    await w.close();
  }
});
