import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from '../db.js';
import { recordAudit } from './audit.js';
import {
  clearPlanDenials,
  humanDeniedDetail,
  listPlanDenials,
  matchingPlanDenial,
  recordPlanDenial,
  sessionHoldWasAbandoned,
  stickyKeyFor,
} from './denials.js';

describe('stickyKeyFor', () => {
  it('keys a shell command by its text, with whitespace collapsed', () => {
    expect(stickyKeyFor('Bash', { command: 'rm   -rf   build' })).toBe('rm -rf build');
    expect(stickyKeyFor('Bash', { command: ' git push \n' })).toBe('git push');
  });
  it('keys a file tool by its path', () => {
    expect(stickyKeyFor('Write', { file_path: '/p/x.ts', content: 'a' })).toBe('/p/x.ts');
  });
  it('falls back to a stable dump for anything else', () => {
    expect(stickyKeyFor('WebFetch', { url: 'https://x' })).toBe('{"url":"https://x"}');
  });
});

describe('recordPlanDenial / matchingPlanDenial', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('matches an identical command for the same plan, and nothing else', () => {
    recordPlanDenial(db, { planId: 'plan-a', tool: 'Bash', matchValue: 'rm -rf build' });
    expect(matchingPlanDenial(db, 'plan-a', 'Bash', 'rm -rf build')).not.toBeNull();
    // A different command, tool, or plan is a different decision.
    expect(matchingPlanDenial(db, 'plan-a', 'Bash', 'rm -rf dist')).toBeNull();
    expect(matchingPlanDenial(db, 'plan-a', 'Read', 'rm -rf build')).toBeNull();
    expect(matchingPlanDenial(db, 'plan-b', 'Bash', 'rm -rf build')).toBeNull();
  });

  it('is idempotent — denying the same thing twice keeps one row', () => {
    recordPlanDenial(db, { planId: 'p', tool: 'Bash', matchValue: 'x' });
    recordPlanDenial(db, { planId: 'p', tool: 'Bash', matchValue: 'x' });
    expect(listPlanDenials(db, 'p')).toHaveLength(1);
  });

  it('clears with the plan', () => {
    recordPlanDenial(db, { planId: 'p', tool: 'Bash', matchValue: 'x' });
    recordPlanDenial(db, { planId: 'p', tool: 'Bash', matchValue: 'y' });
    expect(clearPlanDenials(db, 'p')).toBe(2);
    expect(listPlanDenials(db, 'p')).toHaveLength(0);
  });
});

describe('humanDeniedDetail — only a person counts', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('returns the command a person denied', () => {
    recordAudit(db, {
      kind: 'permission_denied',
      sessionId: 's1',
      summary: 'Denied',
      payload: { tool: 'Bash', args: { command: 'rm -rf build' } },
    });
    expect(humanDeniedDetail(db, 's1')).toBe('rm -rf build');
  });

  it('ignores a timeout and an abandoned hold — nobody looked at those', () => {
    recordAudit(db, {
      kind: 'permission_denied',
      sessionId: 't',
      summary: 'Timed out',
      payload: { tool: 'Bash', args: { command: 'x' }, timedOut: true },
    });
    recordAudit(db, {
      kind: 'permission_denied',
      sessionId: 'a',
      summary: 'Abandoned',
      payload: { tool: 'Bash', args: { command: 'y' }, abandoned: true },
    });
    expect(humanDeniedDetail(db, 't')).toBeUndefined();
    expect(humanDeniedDetail(db, 'a')).toBeUndefined();
    expect(sessionHoldWasAbandoned(db, 'a')).toBe(true);
    expect(sessionHoldWasAbandoned(db, 't')).toBe(false);
  });

  it('ignores an auto-deny from a rule (a different kind entirely)', () => {
    recordAudit(db, {
      kind: 'permission_auto_denied',
      sessionId: 'r',
      summary: 'Rule refused',
      payload: { tool: 'Bash', args: { command: 'z' } },
    });
    expect(humanDeniedDetail(db, 'r')).toBeUndefined();
  });
});
