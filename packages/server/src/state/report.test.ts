import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

// The device key lands in SOLIX_HOME, so point it at a scratch dir before the
// module computes REPORT_KEY_PATH at import time.
const HOME = mkdtempSync(join(tmpdir(), 'solix-report-'));
process.env.SOLIX_HOME = HOME;

const { resetDbForTests } = await import('../db.js');
const { recordAudit } = await import('./audit.js');
const {
  buildReport,
  chainDigest,
  fingerprint,
  reportToCsv,
  reportToMarkdown,
  verifyReport,
} = await import('./report.js');

import type { DB } from '../db.js';

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);

/**
 * `recordAudit` stamps Date.now() and takes no `ts`, so the timestamp is set
 * afterwards. Fixed timestamps matter here beyond tidiness: the digest covers
 * them, so "the same window digests identically" is only meaningful if the
 * events sit at known times rather than wherever the clock was.
 */
function at(db: DB, ts: number, input: Parameters<typeof recordAudit>[1]): void {
  const e = recordAudit(db, input);
  db.prepare('UPDATE audit_events SET ts = ? WHERE id = ?').run(ts, e.id);
}

function seed(db: DB): void {
  at(db, T0, {
    kind: 'permission_approved',
    sessionId: 's1',
    summary: 'approved',
    payload: { tool: 'Bash', command: 'npm test' },
  });
  at(db, T0 + 1000, {
    kind: 'permission_denied',
    sessionId: 's1',
    summary: 'denied',
    payload: { tool: 'Bash', command: 'rm -rf ./build' },
  });
  at(db, T0 + 2000, {
    kind: 'command_blocked',
    sessionId: 's2',
    summary: 'blocked',
    payload: { tool: 'Bash', command: 'rm -rf /', reason: 'dangerous rm' },
  });
}

const WINDOW = { since: T0 - 1000, until: T0 + 10_000 };

describe('fleet report', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
    seed(db);
  });

  it('captures every decision in the window', () => {
    const r = buildReport(db, WINDOW);
    expect(r.records).toHaveLength(3);
    expect(r.records.map((x) => x.decision)).toEqual(['approved', 'denied', 'blocked']);
    expect(r.summary.approved).toBe(1);
    expect(r.summary.denied).toBe(1);
    expect(r.summary.blockedByContainment).toBe(1);
  });

  it('verifies a report it just produced', () => {
    const r = buildReport(db, WINDOW);
    expect(verifyReport(r)).toEqual({ ok: true, signed: true });
  });

  it('is deterministic — the same window digests identically', () => {
    const a = buildReport(db, WINDOW);
    const b = buildReport(db, WINDOW);
    expect(b.chain.digest).toBe(a.chain.digest);
  });

  /**
   * The point of the whole file. Each of these is a way someone could doctor a
   * report, and each must be caught.
   */
  describe('tamper detection', () => {
    it('catches an edited command', () => {
      const r = buildReport(db, WINDOW);
      r.records[2]!.detail = 'rm -rf ./safe-looking-path';
      const v = verifyReport(r);
      expect(v.ok).toBe(false);
      expect(v).toMatchObject({ reason: expect.stringContaining('altered') });
    });

    it('catches a deleted record', () => {
      const r = buildReport(db, WINDOW);
      r.records.splice(1, 1); // drop the denial
      expect(verifyReport(r).ok).toBe(false);
    });

    it('catches an inserted record', () => {
      const r = buildReport(db, WINDOW);
      r.records.push({ ts: T0 + 5000, decision: 'approved', tool: 'Bash', detail: 'whoami' });
      expect(verifyReport(r).ok).toBe(false);
    });

    it('catches reordered records', () => {
      const r = buildReport(db, WINDOW);
      [r.records[0], r.records[1]] = [r.records[1]!, r.records[0]!];
      expect(verifyReport(r).ok).toBe(false);
    });

    it('catches a truncated report whose digest was left alone', () => {
      const r = buildReport(db, WINDOW);
      r.records = r.records.slice(0, 1);
      expect(verifyReport(r).ok).toBe(false);
    });

    /**
     * The careful forgery: edit a record AND recompute the digest to match.
     * The chain alone would accept this; the signature is what refuses it.
     */
    it('catches an edit whose digest was recomputed, via the signature', () => {
      const r = buildReport(db, WINDOW);
      r.records[2]!.detail = 'echo harmless';
      r.chain.digest = chainDigest(r.records, r.window, r.redacted);
      const v = verifyReport(r);
      expect(v.ok).toBe(false);
      expect(v).toMatchObject({ reason: expect.stringContaining('signature') });
    });

    it('catches a widened window', () => {
      const r = buildReport(db, WINDOW);
      r.window = { since: 0, until: T0 + 99_999 };
      expect(verifyReport(r).ok).toBe(false);
    });

    it('catches a report relabelled as redacted', () => {
      const r = buildReport(db, WINDOW);
      r.redacted = true;
      expect(verifyReport(r).ok).toBe(false);
    });
  });

  it('accepts an unsigned report as unsigned, not as invalid', () => {
    const r = buildReport(db, { ...WINDOW, unsigned: true });
    expect(r.signature).toBeUndefined();
    expect(verifyReport(r)).toEqual({ ok: true, signed: false });
  });

  it('still catches tampering in an unsigned report', () => {
    const r = buildReport(db, { ...WINDOW, unsigned: true });
    r.records[0]!.tool = 'Write';
    expect(verifyReport(r).ok).toBe(false);
  });

  describe('redaction', () => {
    it('replaces commands with stable fingerprints', () => {
      const r = buildReport(db, { ...WINDOW, redact: true });
      expect(r.redacted).toBe(true);
      for (const rec of r.records) expect(rec.detail).toMatch(/^fp:[0-9a-f]{16}$/);
      // Still verifiable, and still says what was blocked and why.
      expect(verifyReport(r)).toEqual({ ok: true, signed: true });
      expect(r.records[2]!.reason).toBe('dangerous rm');
    });

    it('fingerprints the same command to the same value', () => {
      expect(fingerprint('rm -rf /')).toBe(fingerprint('rm -rf /'));
      expect(fingerprint('rm -rf /')).not.toBe(fingerprint('rm -rf ./x'));
    });

    it('digests differently from the unredacted report of the same window', () => {
      const full = buildReport(db, WINDOW);
      const red = buildReport(db, { ...WINDOW, redact: true });
      expect(red.chain.digest).not.toBe(full.chain.digest);
    });
  });

  describe('rendering', () => {
    it('markdown carries the counts, the digest and the honest caveat', () => {
      const md = reportToMarkdown(buildReport(db, WINDOW));
      expect(md).toContain('# Solix fleet report');
      expect(md).toContain('| Blocked by containment | 1 |');
      expect(md).toContain('dangerous rm');
      expect(md).toMatch(/\*\*Digest:\*\* `[0-9a-f]{64}`/);
      // The claim must not be overstated anywhere it is shown.
      expect(md).toContain('does not prove');
    });

    it('markdown escapes pipes so a command cannot break the table', () => {
      const d = resetDbForTests();
      at(d, T0, {
        kind: 'permission_approved',
        sessionId: 's1',
        summary: 'a',
        payload: { tool: 'Bash', command: 'cat x | grep y' },
      });
      const md = reportToMarkdown(buildReport(d, WINDOW));
      expect(md).toContain('cat x \\| grep y');
    });

    it('csv quotes fields and doubles embedded quotes', () => {
      const d = resetDbForTests();
      at(d, T0, {
        kind: 'permission_approved',
        sessionId: 's1',
        summary: 'a',
        payload: { tool: 'Bash', command: 'echo "hi, there"' },
      });
      const csv = reportToCsv(buildReport(d, WINDOW));
      expect(csv.split('\n')[0]).toContain('"timestamp_utc"');
      expect(csv).toContain('"echo ""hi, there"""');
    });
  });

  it('an empty window still produces a verifiable report', () => {
    const r = buildReport(resetDbForTests(), WINDOW);
    expect(r.records).toEqual([]);
    expect(verifyReport(r)).toEqual({ ok: true, signed: true });
    expect(reportToMarkdown(r)).toContain('No decisions in this window');
  });
});
