import { describe, expect, it } from 'vitest';

import { computeHealth, healthColor } from './health.js';
import type { Session } from '@solix/shared';

/**
 * The score had no tests, and the gap showed in the most visible way
 * possible: every idle agent read exactly 85, because the `progress` band was
 * only awarded for an active mission and an idle agent can never earn it. It
 * was arithmetically correct and informationally empty — 456 identical rows.
 *
 * So the test that matters most is the dullest one: an agent with nothing
 * wrong scores 100.
 */
function session(over: Partial<Session> = {}): Session {
  return {
    id: 's1',
    status: 'idle',
    contextUsagePct: 0,
    ...over,
  } as Session;
}

const scoreOf = (s: Partial<Session>, pending = 0): number =>
  computeHealth(session(s), undefined, pending).score;

describe('computeHealth', () => {
  describe('the common case', () => {
    it('an idle agent with nothing wrong is 100, not 85', () => {
      expect(scoreOf({ status: 'idle' })).toBe(100);
    });

    it('an active agent with nothing wrong is also 100', () => {
      expect(scoreOf({ status: 'active' })).toBe(100);
    });

    it('is green', () => {
      expect(healthColor(scoreOf({ status: 'idle' }))).toBe('#10b981');
    });
  });

  describe('context pressure', () => {
    it('barely registers when there is plenty left', () => {
      // The real reading that prompted this: 24% used.
      expect(scoreOf({ contextUsagePct: 24 })).toBeGreaterThanOrEqual(95);
    });

    it('bites near the top, where it actually hurts', () => {
      const warm = scoreOf({ contextUsagePct: 75 });
      const hot = scoreOf({ contextUsagePct: 95 });
      expect(warm).toBeLessThan(85);
      expect(hot).toBeLessThan(warm);
      expect(hot).toBeLessThan(70);
    });

    it('falls monotonically as context fills', () => {
      const scores = [0, 25, 50, 75, 100].map((p) =>
        scoreOf({ contextUsagePct: p }),
      );
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i]!).toBeLessThan(scores[i - 1]!);
      }
    });

    it('says so once it is worth saying', () => {
      const { reasons } = computeHealth(session({ contextUsagePct: 92 }), undefined, 0);
      expect(reasons.join(' ')).toMatch(/context at 92%/i);
    });
  });

  describe('waiting on you', () => {
    /** Work has stopped. That is not a healthy agent, whoever is at fault. */
    it('one held command drops it out of the green', () => {
      const s = scoreOf({ status: 'awaiting_permission' }, 1);
      expect(s).toBeLessThan(75);
      expect(healthColor(s)).not.toBe('#10b981');
    });

    it('a queue behind it costs more', () => {
      expect(scoreOf({}, 3)).toBeLessThan(scoreOf({}, 1));
    });

    it('names the count', () => {
      const { reasons } = computeHealth(session(), undefined, 2);
      expect(reasons.join(' ')).toMatch(/2 commands waiting on you/i);
    });

    /**
     * `awaiting_permission` and a pending count describe the same fact. Taking
     * both would punish one situation twice and make the number unreadable.
     */
    it('does not charge twice for the same held command', () => {
      expect(scoreOf({ status: 'awaiting_permission' }, 1)).toBe(scoreOf({}, 1));
    });
  });

  describe('status', () => {
    it('an error is total, and nothing else is worth saying', () => {
      const { score, reasons } = computeHealth(
        session({ status: 'error', contextUsagePct: 10 }),
        undefined,
        0,
      );
      expect(score).toBe(0);
      expect(reasons).toEqual(['In error state']);
    });

    it('terminated is over, not unwell — a dent, not a collapse', () => {
      const s = scoreOf({ status: 'terminated' });
      expect(s).toBeLessThan(100);
      expect(s).toBeGreaterThanOrEqual(50);
    });

    it('needs-you states without a raised permission still cost', () => {
      expect(scoreOf({ status: 'awaiting_input' })).toBeLessThan(100);
    });
  });

  it('never leaves the 0–100 range, whatever is wrong at once', () => {
    const { score } = computeHealth(
      session({ status: 'terminated', contextUsagePct: 100 }),
      undefined,
      9,
    );
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});
