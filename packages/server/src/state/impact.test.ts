import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from '../db.js';
import { recordAudit, summarizeImpact } from './audit.js';

/**
 * The impact report is the evidence Solix has never been able to produce:
 * what it stopped. These pin the two distinctions that make the number mean
 * anything — automatic refusals separated from human denials, and spend
 * actually held at a cap.
 */
const DAY = 24 * 60 * 60 * 1000;

describe('summarizeImpact', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('separates what the denylist caught from what a human refused', () => {
    recordAudit(db, { kind: 'permission_denied', summary: 'you said no' });
    recordAudit(db, {
      kind: 'command_blocked',
      summary: 'containment blocked Bash',
      payload: { reason: 'privilege escalation (sudo)' },
    });
    recordAudit(db, {
      kind: 'command_blocked',
      summary: 'containment blocked Bash',
      payload: { reason: 'privilege escalation (sudo)' },
    });
    recordAudit(db, {
      kind: 'command_blocked',
      summary: 'containment blocked Bash',
      payload: { reason: 'fork bomb' },
    });
    recordAudit(db, { kind: 'permission_approved', summary: 'you said yes' });

    const s = summarizeImpact(db);

    // The headline distinction: three were never seen by a human.
    expect(s.blockedByContainment).toBe(3);
    expect(s.denied).toBe(1);
    expect(s.approved).toBe(1);

    // Reasons ranked, commonest first — this is what makes the report readable.
    expect(s.blockReasons).toEqual([
      { reason: 'privilege escalation (sudo)', count: 2 },
      { reason: 'fork bomb', count: 1 },
    ]);
  });

  it('totals the spend held at budget pauses', () => {
    recordAudit(db, {
      kind: 'budget_paused',
      summary: 'paused',
      payload: { planId: 'p1', spentUsd: 4.25, budgetUsd: 5 },
    });
    recordAudit(db, {
      kind: 'budget_paused',
      summary: 'paused',
      payload: { planId: 'p2', spentUsd: 1.1, budgetUsd: 2 },
    });

    const s = summarizeImpact(db);
    expect(s.budgetPauses).toBe(2);
    expect(s.spendAtPauseUsd).toBeCloseTo(5.35, 6);
  });

  /**
   * CLAIM-COST-COUNTED-ONCE, in the impact summary.
   *
   * `spentUsd` is the plan's cumulative spend at the moment it paused, not
   * the increment since the last pause — and a plan can pause more than
   * once with its budget unchanged, because `resumePlan`, `retryTask` and
   * `addFollowUpTask` all put a paused plan straight back to `running` and
   * the next tick re-evaluates the same breach.
   *
   * Summing the rows therefore counted the same dollars again, and `solix
   * gain` prints the result as "Spend held at those pauses", which reads to
   * a person as money saved. The test above passes either way, because it
   * uses two *different* plans.
   */
  it('counts a re-paused plan once, not once per pause', () => {
    for (const spent of [4.25, 7.5, 9.0]) {
      recordAudit(db, {
        kind: 'budget_paused',
        summary: 'paused',
        payload: { planId: 'p1', spentUsd: spent, budgetUsd: 5 },
      });
    }

    const s = summarizeImpact(db);
    expect(s.budgetPauses, 'all three pauses still happened').toBe(3);
    // Not 20.75. The plan was holding $9.00 when it last stopped.
    expect(s.spendAtPauseUsd).toBeCloseTo(9.0, 6);
  });

  it('adds up distinct plans while deduplicating each one', () => {
    for (const [planId, spent] of [
      ['p1', 4.25],
      ['p1', 6.0],
      ['p2', 1.1],
    ] as const) {
      recordAudit(db, {
        kind: 'budget_paused',
        summary: 'paused',
        payload: { planId, spentUsd: spent, budgetUsd: 10 },
      });
    }
    expect(summarizeImpact(db).spendAtPauseUsd).toBeCloseTo(7.1, 6);
  });

  it('still counts a pause recorded before planId was in the payload', () => {
    // Old rows have no planId and cannot be grouped. Counting them
    // individually is the previous behaviour and the best available.
    recordAudit(db, {
      kind: 'budget_paused',
      summary: 'paused',
      payload: { spentUsd: 2.5, budgetUsd: 5 },
    });
    recordAudit(db, {
      kind: 'budget_paused',
      summary: 'paused',
      payload: { spentUsd: 3.5, budgetUsd: 5 },
    });
    expect(summarizeImpact(db).spendAtPauseUsd).toBeCloseTo(6.0, 6);
  });

  it('respects the window', () => {
    const now = Date.now();
    recordAudit(db, { kind: 'command_blocked', summary: 'recent' });
    // Backdate one well outside the default 30-day window.
    db.prepare(`UPDATE audit_events SET ts = ? WHERE summary = 'recent'`).run(
      now - 90 * DAY,
    );
    recordAudit(db, { kind: 'command_blocked', summary: 'today' });

    expect(summarizeImpact(db).blockedByContainment).toBe(1);
    expect(
      summarizeImpact(db, { since: now - 120 * DAY }).blockedByContainment,
    ).toBe(2);
  });

  /**
   * A row written by an older build, or by a path that forgot the payload,
   * must still be counted. Losing the count because the reason is missing
   * would understate exactly the number this report exists to show.
   */
  it('counts a block whose payload is missing or malformed', () => {
    recordAudit(db, { kind: 'command_blocked', summary: 'no payload' });
    recordAudit(db, {
      kind: 'command_blocked',
      summary: 'bad payload',
      payload: { nothing: 'useful' },
    });
    db.prepare(
      `INSERT INTO audit_events (id, ts, kind, summary, payload_json)
       VALUES ('x', ?, 'command_blocked', 'not json', '{oops')`,
    ).run(Date.now());

    const s = summarizeImpact(db);
    expect(s.blockedByContainment).toBe(3);
    expect(s.blockReasons).toEqual([]);
  });

  it('is all zeroes on a fresh install rather than throwing', () => {
    const s = summarizeImpact(db);
    expect(s.approved).toBe(0);
    expect(s.denied).toBe(0);
    expect(s.blockedByContainment).toBe(0);
    expect(s.budgetPauses).toBe(0);
    expect(s.spendAtPauseUsd).toBe(0);
    expect(s.blockReasons).toEqual([]);
    expect(s.untilMs).toBeGreaterThan(s.sinceMs);
  });
});
