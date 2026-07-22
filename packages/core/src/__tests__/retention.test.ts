import { describe, expect, it } from 'vitest';
import { resolveRetentionPolicy, retentionCutoffs } from '../retention';

describe('resolveRetentionPolicy', () => {
  it('defaults to 30/90/30 days', () => {
    const defaults = { completed: 30, failed: 90, logs: 30 };
    expect(resolveRetentionPolicy()).toEqual(defaults);
    expect(resolveRetentionPolicy({})).toEqual(defaults);
  });

  it('keeps explicit windows and lets false disable a field', () => {
    expect(
      resolveRetentionPolicy({ completed: 7, failed: false, logs: 1 }),
    ).toEqual({ completed: 7, failed: false, logs: 1 });
  });

  it('rejects invalid windows, naming the offending field', () => {
    expect(() => resolveRetentionPolicy({ completed: 0 })).toThrow(
      /retention\.completed must be a positive number of days or false/,
    );
    expect(() => resolveRetentionPolicy({ failed: -1 })).toThrow(
      /retention\.failed/,
    );
    expect(() => resolveRetentionPolicy({ logs: Number.NaN })).toThrow(
      /retention\.logs/,
    );
  });
});

describe('retentionCutoffs', () => {
  it('anchors each cutoff N days before now and omits disabled fields', () => {
    const now = new Date('2026-07-01T00:00:00.000Z');
    const cutoffs = retentionCutoffs(
      { completed: 30, failed: false, logs: 1 },
      now,
    );
    expect(cutoffs.completedBefore?.toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
    expect(cutoffs.failedBefore).toBeUndefined();
    expect(cutoffs.logsBefore?.toISOString()).toBe('2026-06-30T00:00:00.000Z');
  });
});
