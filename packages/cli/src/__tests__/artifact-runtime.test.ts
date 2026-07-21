import { afterEach, describe, expect, test } from 'bun:test';
import { resolvePort, satisfiesNodeFloor } from '../artifact-start';

// The artifact floor is `^20.19 || >=22.12`: 20.19+ within the 20.x line, or
// 22.12 and up (23.x, 24.x). 21.x and 22.0–22.11 sit in the gap.
describe('satisfiesNodeFloor', () => {
  test.each([
    ['v20.19.0', true],
    ['v20.20.5', true],
    ['v22.12.0', true],
    ['v22.20.1', true],
    ['v23.0.0', true],
    ['v24.11.1', true],
    ['24.11.1', true], // no leading v
  ])('accepts %s', (version, expected) => {
    expect(satisfiesNodeFloor(version)).toBe(expected);
  });

  test.each([
    ['v20.18.9', false], // below the 20.19 floor
    ['v20.11.1', false], // package floor, but under Nitro's
    ['v21.7.3', false], // gap
    ['v22.0.0', false], // gap
    ['v22.11.9', false], // gap
    ['v18.20.4', false], // too old
    ['v1.3.13', false], // Bun masquerading as `node`
    ['not-a-version', false],
    ['', false],
  ])('rejects %s', (version, expected) => {
    expect(satisfiesNodeFloor(version)).toBe(expected);
  });
});

// The artifact runs in a subprocess on a fixed port the CLI health-polls, so an
// OS-assigned ephemeral port (PORT=0) is unreachable and must be rejected here.
describe('resolvePort', () => {
  const original = process.env.PORT;
  afterEach(() => {
    if (original === undefined) delete process.env.PORT;
    else process.env.PORT = original;
  });

  test('defaults to 8090 when PORT is unset', () => {
    delete process.env.PORT;
    expect(resolvePort()).toBe(8090);
  });

  test('accepts a valid port', () => {
    process.env.PORT = '3000';
    expect(resolvePort()).toBe(3000);
  });

  test('rejects PORT=0', () => {
    process.env.PORT = '0';
    expect(() => resolvePort()).toThrow('between 1 and 65535');
  });

  test('rejects a non-numeric PORT', () => {
    process.env.PORT = 'abc';
    expect(() => resolvePort()).toThrow('between 1 and 65535');
  });
});
