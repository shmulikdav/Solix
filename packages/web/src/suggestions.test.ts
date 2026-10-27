import { describe, expect, it } from 'vitest';

import { isDestructive, suggestForPermission } from './suggestions.js';
import type { Session } from '@solix/shared';

/**
 * The hint on a decision card is the only thing between "read every command
 * carefully" and "approve the one that looks familiar". It had no tests, and
 * the gap showed: a denied agent reworded `rm -rf ./canary` as
 * `rm /abs/canary/keep.txt && rmdir /abs/canary` and got no warning, because
 * the rule matched the literal string `rm -rf`.
 *
 * Everything in `rephrasings` is a command that destroys something, written
 * the way an agent writes it after its first attempt was refused.
 */
const rephrasings = [
  'rm -rf /Users/me/project/canary',
  'rm /Users/me/project/canary/keep.txt && rmdir /Users/me/project/canary',
  'rm -r build',
  'rm -f .env',
  'rm notes.txt',
  'rmdir ./empty',
  'sudo systemctl restart nginx',
  'git clean -fd',
  'git reset --hard HEAD~3',
  'git checkout -- src/index.ts',
  'git branch -D feature/x',
  'shred -u secrets.txt',
  'truncate -s 0 app.log',
  'dd if=/dev/zero of=/dev/disk2',
  'find . -name "*.tmp" -delete',
  'find . -type f -exec rm {} \\;',
  'docker system prune -af',
  'docker volume rm pgdata',
  'echo "" > /etc/hosts',
];

/** Commands that read, build or inspect. A warning on these is just noise. */
const harmless = [
  'ls -la canary',
  'git status --short',
  'git log --oneline -3',
  'npm test',
  'pnpm -r build',
  'cat README.md',
  'grep -rn TODO src',
  'git diff --stat',
  'node --version',
  'mkdir -p build',
  'echo hello',
  'git add -A',
  'curl -s https://example.com',
];

describe('isDestructive', () => {
  for (const c of rephrasings) {
    it(`flags: ${c}`, () => {
      expect(isDestructive(c)).toBe(true);
    });
  }

  for (const c of harmless) {
    it(`leaves alone: ${c}`, () => {
      expect(isDestructive(c)).toBe(false);
    });
  }

  /** The exact pair from the session that found this. */
  it('flags BOTH spellings of the same deletion', () => {
    expect(isDestructive('rm -rf /Users/me/solix-qa/canary')).toBe(true);
    expect(
      isDestructive('rm /Users/me/solix-qa/canary/keep.txt && rmdir /Users/me/solix-qa/canary'),
    ).toBe(true);
  });
});

const session = {
  id: 's1',
  contextUsagePct: 10,
} as unknown as Session;

describe('suggestForPermission', () => {
  it('warns on the reworded deletion, not only on rm -rf', () => {
    const s = suggestForPermission(session, undefined, 'Bash', {
      command: 'rm /tmp/x/keep.txt && rmdir /tmp/x',
    });
    expect(s?.severity).toBe('danger');
    expect(s?.text).toMatch(/destructive/i);
  });

  it('stays quiet on a read-only command', () => {
    expect(
      suggestForPermission(session, undefined, 'Bash', { command: 'ls -la canary' }),
    ).toBeNull();
  });

  it('still flags a secrets file edit', () => {
    const s = suggestForPermission(session, undefined, 'Write', {
      file_path: '/app/.env',
    });
    expect(s?.severity).toBe('danger');
  });
});
