import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, resolvePort } from './port.js';

/**
 * The table is written out rather than derived, because a table generated
 * from the function would agree with a wrong function.
 */
describe('resolvePort', () => {
  it('takes a port when it is given one', () => {
    expect(resolvePort('5000')).toBe(5000);
    expect(resolvePort('1')).toBe(1);
    expect(resolvePort('65535')).toBe(65535);
    expect(resolvePort('  5000  ')).toBe(5000);
  });

  it('falls back when the variable is unset', () => {
    expect(resolvePort(undefined)).toBe(DEFAULT_PORT);
  });

  it('falls back when the variable is set but empty', () => {
    // The whole reason this function exists. `process.env.SOLIX_PORT ?? 4242`
    // reads this as port 0, because `??` only fires on null and undefined.
    expect(resolvePort('')).toBe(DEFAULT_PORT);
    expect(resolvePort('   ')).toBe(DEFAULT_PORT);
  });

  it('falls back on anything that is not a port number', () => {
    // '0x10' and '1e3' are the ones a bare Number() would have accepted,
    // quietly resolving to 16 and 1000.
    for (const raw of [
      'auto',
      '0',
      '-1',
      '70000',
      '65536',
      '4242.5',
      'NaN',
      '0x10',
      '1e3',
      '+4242',
      '42 42',
    ]) {
      expect(resolvePort(raw), raw).toBe(DEFAULT_PORT);
    }
  });

  it('reads the environment when asked for nothing', () => {
    const saved = process.env.SOLIX_PORT;
    try {
      process.env.SOLIX_PORT = '4455';
      expect(resolvePort()).toBe(4455);
      process.env.SOLIX_PORT = '';
      expect(resolvePort()).toBe(DEFAULT_PORT);
    } finally {
      if (saved === undefined) delete process.env.SOLIX_PORT;
      else process.env.SOLIX_PORT = saved;
    }
  });
});
