import { describe, expect, it } from 'vitest';
import { unwrapInput } from '../snapshot';

/**
 * A job enqueued with `undefined` input serializes to an envelope with no
 * `__input` key (JSON drops undefined — Postgres jsonb, BullMQ). The consumer
 * must still hand the task `undefined`, not the internal envelope.
 */
describe('unwrapInput', () => {
  it('returns the input when __input is present', () => {
    expect(
      unwrapInput({
        __input: { hello: 'world' },
        __runId: 'r',
        __metadata: {},
      }),
    ).toEqual({ hello: 'world' });
  });

  it('recovers undefined input dropped by JSON serialization', () => {
    const envelope = {
      __input: undefined,
      __runId: 'r',
      __meta: { tags: ['run:r'] },
      __metadata: {},
    };
    const serialized = JSON.parse(JSON.stringify(envelope));
    expect('__input' in serialized).toBe(false);
    expect(unwrapInput(serialized)).toBeUndefined();
  });

  it('returns a raw externally-enqueued job as-is', () => {
    // No envelope markers → not our wrapper; hand the whole payload through.
    expect(unwrapInput({ foo: 1, bar: 2 })).toEqual({ foo: 1, bar: 2 });
  });

  it('returns a primitive payload as-is', () => {
    expect(unwrapInput('raw-string')).toBe('raw-string');
  });
});
