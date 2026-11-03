import { describe, expect, it } from 'vitest';
import { ruleCommandFor } from './ledger.js';

/**
 * The ledger used to say "approved 4 times — worth a rule rather than a
 * decision" and leave the reader to work out which rule. This is the line
 * that now follows it, so it had better be a command that works.
 */
describe('ruleCommandFor', () => {
  it('turns a repeated shell approval into a one- or two-word prefix rule', () => {
    expect(ruleCommandFor('Bash', 'git status --short && git log --oneline')).toBe(
      'solix rules add --prefix "git status"',
    );
    expect(ruleCommandFor('Bash', 'ls -la /home/me/project; node --version')).toBe(
      'solix rules add --prefix "ls"',
    );
    expect(ruleCommandFor('Bash', '(cd src && node --test)')).toBe('solix rules add --prefix "cd"');
  });

  it('turns repeated reads and in-project writes into their matcher', () => {
    expect(ruleCommandFor('Read', '/home/me/project/SPEC.md')).toBe('solix rules add --readonly');
    expect(ruleCommandFor('Grep', 'x')).toBe('solix rules add --readonly');
    expect(ruleCommandFor('Write', '/home/me/project/src/count.js')).toBe('solix rules add --writes-inside-root');
    expect(ruleCommandFor('Edit', '/home/me/project/src/count.js')).toBe('solix rules add --writes-inside-root');
  });

  it('suggests nothing for a tool it cannot make a rule for', () => {
    expect(ruleCommandFor('WebFetch', 'https://example.com')).toBeNull();
    expect(ruleCommandFor('Bash', '')).toBeNull();
  });
});
