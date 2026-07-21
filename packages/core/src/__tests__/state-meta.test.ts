import { describe, expect, it } from 'vitest';
import { containsMeta } from '../store/filter';
import type { EnqueueMeta } from '../types';

describe('containsMeta — deep containment (Postgres @> parity)', () => {
  it('matches a scalar equality on a top-level key', () => {
    const meta: EnqueueMeta = { parentRunId: 'p1' };
    expect(containsMeta(meta, { parentRunId: 'p1' })).toBe(true);
    expect(containsMeta(meta, { parentRunId: 'other' })).toBe(false);
  });

  it('matches a partial nested object (enqueuedBy.tenantId)', () => {
    const meta: EnqueueMeta = {
      enqueuedBy: {
        authenticator: 'api-key',
        principalId: 'api-key',
        principalType: 'service',
        tenantId: 't1',
      },
    };
    expect(containsMeta(meta, { enqueuedBy: { tenantId: 't1' } })).toBe(true);
    expect(containsMeta(meta, { enqueuedBy: { tenantId: 't2' } })).toBe(false);
    expect(
      containsMeta(meta, {
        enqueuedBy: { tenantId: 't1', principalType: 'service' },
      }),
    ).toBe(true);
  });

  it('requires the actual value to be an object when the filter is one', () => {
    const meta: EnqueueMeta = { enqueuedBy: undefined };
    expect(containsMeta(meta, { enqueuedBy: { tenantId: 't1' } })).toBe(false);
  });

  it('matches arrays by element containment (every expected in some actual)', () => {
    const meta: EnqueueMeta = { tags: ['a', 'b', 'c'] };
    expect(containsMeta(meta, { tags: ['b'] })).toBe(true);
    expect(containsMeta(meta, { tags: ['a', 'c'] })).toBe(true);
    expect(containsMeta(meta, { tags: ['z'] })).toBe(false);
  });

  it('returns true for an empty filter', () => {
    expect(containsMeta({ parentRunId: 'p1' }, {})).toBe(true);
  });
});
