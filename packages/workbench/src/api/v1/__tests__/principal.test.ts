import type { Principal } from '@openqueue/core';
import { describe, expect, it } from 'vitest';
import {
  canAccess,
  scopeMetaFilter,
  stampMeta,
  toRunPrincipal,
} from '../principal';

function principal(tenantId?: string): Principal {
  const base: Principal = {
    authenticator: 'api-key',
    principalId: 'api-key',
    principalType: 'service',
    issuer: 'iss',
    subject: 'sub',
    attributes: { scope: 'x' },
  };
  if (tenantId !== undefined) base.tenantId = tenantId;
  return base;
}

describe('toRunPrincipal', () => {
  it('projects the 4 stamped fields, dropping issuer/subject/attributes', () => {
    expect(toRunPrincipal(principal('t1'))).toEqual({
      authenticator: 'api-key',
      principalId: 'api-key',
      principalType: 'service',
      tenantId: 't1',
    });
  });

  it('omits tenantId when absent', () => {
    expect(toRunPrincipal(principal())).toEqual({
      authenticator: 'api-key',
      principalId: 'api-key',
      principalType: 'service',
    });
  });
});

describe('stampMeta', () => {
  it('stamps the principal and strips inbound enqueuedBy', () => {
    const result = stampMeta(
      {
        tags: ['a'],
        enqueuedBy: {
          authenticator: 'spoof',
          principalId: 'evil',
          principalType: 'service',
          tenantId: 'other',
        },
      },
      principal('t1'),
    );
    expect(result).toEqual({
      tags: ['a'],
      enqueuedBy: {
        authenticator: 'api-key',
        principalId: 'api-key',
        principalType: 'service',
        tenantId: 't1',
      },
    });
  });

  it('strips inbound enqueuedBy even without a principal', () => {
    const result = stampMeta(
      {
        tags: ['a'],
        enqueuedBy: {
          authenticator: 'spoof',
          principalId: 'evil',
          principalType: 'service',
        },
      },
      undefined,
    );
    expect(result).toEqual({ tags: ['a'] });
  });

  it('returns undefined when there is nothing to carry', () => {
    expect(stampMeta(undefined, undefined)).toBeUndefined();
  });

  it('stamps onto empty meta when no meta is supplied', () => {
    expect(stampMeta(undefined, principal('t1'))).toEqual({
      enqueuedBy: {
        authenticator: 'api-key',
        principalId: 'api-key',
        principalType: 'service',
        tenantId: 't1',
      },
    });
  });
});

describe('canAccess', () => {
  it('grants a super-principal (no tenantId) access to everything', () => {
    expect(canAccess(principal(), { enqueuedBy: undefined })).toBe(true);
    expect(canAccess(undefined, {})).toBe(true);
  });

  it('grants a tenant access only to its own resources', () => {
    expect(
      canAccess(principal('t1'), {
        enqueuedBy: {
          authenticator: 'api-key',
          principalId: 'api-key',
          principalType: 'service',
          tenantId: 't1',
        },
      }),
    ).toBe(true);
    expect(
      canAccess(principal('t2'), {
        enqueuedBy: {
          authenticator: 'api-key',
          principalId: 'api-key',
          principalType: 'service',
          tenantId: 't1',
        },
      }),
    ).toBe(false);
  });

  it('denies unowned resources to tenant-scoped callers', () => {
    expect(canAccess(principal('t1'), {})).toBe(false);
  });
});

describe('scopeMetaFilter', () => {
  it('passes the filter through for a super-principal', () => {
    expect(scopeMetaFilter(principal(), { task: 'x' })).toEqual({ task: 'x' });
    expect(scopeMetaFilter(principal(), undefined)).toBeUndefined();
  });

  it('injects the caller tenantId, forcing it over a supplied one', () => {
    expect(
      scopeMetaFilter(principal('t1'), { enqueuedBy: { tenantId: 't2' } }),
    ).toEqual({ enqueuedBy: { tenantId: 't1' } });
  });

  it('injects into an empty filter', () => {
    expect(scopeMetaFilter(principal('t1'), undefined)).toEqual({
      enqueuedBy: { tenantId: 't1' },
    });
  });

  it('discards a non-object enqueuedBy and forces the tenant filter', () => {
    expect(scopeMetaFilter(principal('t1'), { enqueuedBy: 't2' })).toEqual({
      enqueuedBy: { tenantId: 't1' },
    });
    expect(scopeMetaFilter(principal('t1'), { enqueuedBy: ['t2'] })).toEqual({
      enqueuedBy: { tenantId: 't1' },
    });
  });
});
