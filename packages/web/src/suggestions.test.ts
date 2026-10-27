import { describe, expect, it } from 'vitest';

import {
  isDestructive,
  severityRank,
  suggestForPermission,
  suggestForSession,
} from './suggestions.js';
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

/**
 * This took over from `health.ts`, a second scorer over the same three
 * signals that produced a 0–100 number. The number was unreadable — it
 * blended "will start forgetting soon" with "is blocked waiting on you", so
 * nobody could say why an agent was 70 rather than 65 — and a terminated
 * agent scored 80 and showed green, which is what made the problem plain.
 *
 * The property that matters most is the quietest one: a healthy agent gets
 * nothing at all.
 */
function sess(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    status: 'idle',
    contextUsagePct: 0,
    ...over,
  } as unknown as Session;
}

describe('suggestForSession', () => {
  it('says NOTHING about a healthy idle agent', () => {
    expect(suggestForSession(sess(), undefined, 0)).toBeNull();
  });

  it('says nothing about a healthy active agent either', () => {
    expect(suggestForSession(sess({ status: 'active' }), undefined, 0)).toBeNull();
  });

  /** The case that prompted the whole change: terminated is over, not unwell. */
  it('reads "Done" for a terminated agent, not a score', () => {
    const s = suggestForSession(sess({ status: 'terminated' }), undefined, 0);
    expect(s?.text).toBe('Done');
    expect(s?.severity).toBe('info');
  });

  describe('held commands', () => {
    it('names how many are waiting', () => {
      expect(suggestForSession(sess(), undefined, 2)?.text).toBe(
        '2 commands waiting on you',
      );
    });

    it('is singular for one', () => {
      expect(suggestForSession(sess(), undefined, 1)?.text).toBe(
        '1 command waiting on you',
      );
    });

    /**
     * Being blocked stops work now; a full context degrades it later. The
     * first match wins, so the order of the checks is the priority.
     */
    it('outranks context pressure', () => {
      const s = suggestForSession(sess({ contextUsagePct: 95 }), undefined, 1);
      expect(s?.text).toMatch(/waiting on you/);
    });

    it('is outranked by an error, which is worse than blocked', () => {
      const s = suggestForSession(sess({ status: 'error' }), undefined, 3);
      expect(s?.text).toMatch(/error state/i);
    });
  });

  describe('context pressure', () => {
    it('keeps the real percentage in the text, so it says what to do', () => {
      expect(suggestForSession(sess({ contextUsagePct: 92 }), undefined, 0)?.text).toContain(
        '92%',
      );
    });

    it('stays quiet while there is plenty left', () => {
      expect(suggestForSession(sess({ contextUsagePct: 24 }), undefined, 0)).toBeNull();
    });

    it('warns louder past 90 than past 80', () => {
      const warm = suggestForSession(sess({ contextUsagePct: 85 }), undefined, 0);
      const hot = suggestForSession(sess({ contextUsagePct: 95 }), undefined, 0);
      expect(severityRank(hot)).toBeGreaterThan(severityRank(warm));
    });
  });

  it('flags a needs-you status that raised no permission', () => {
    expect(suggestForSession(sess({ status: 'awaiting_input' }), undefined, 0)?.text).toBe(
      'Needs you',
    );
  });

  it('leaves existing callers alone — the pending count defaults to none', () => {
    expect(suggestForSession(sess({ contextUsagePct: 95 }), undefined)).not.toBeNull();
  });
});

describe('severityRank', () => {
  /** The List sorts on this, so the order has to be strict. */
  it('orders danger > warn > info > nothing', () => {
    const rank = (sev: 'danger' | 'warn' | 'info') =>
      severityRank({ severity: sev, text: 'x' });
    expect(rank('danger')).toBeGreaterThan(rank('warn'));
    expect(rank('warn')).toBeGreaterThan(rank('info'));
    expect(rank('info')).toBeGreaterThan(severityRank(null));
  });
});
