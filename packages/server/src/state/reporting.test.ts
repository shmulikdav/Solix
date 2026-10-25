import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

const HOME = mkdtempSync(join(tmpdir(), 'solix-reporting-'));
process.env.SOLIX_HOME = HOME;

const { resetDbForTests } = await import('../db.js');
const { recordAudit } = await import('./audit.js');
const { verifyDigestSignature, chainDigest } = await import('./report.js');
const {
  MAX_BATCH,
  getCursor,
  pendingBatch,
  push,
  pushOnce,
  readReportingConfig,
  reportingEnabled,
  writeReportingConfig,
} = await import('./reporting.js');

import type { DB } from '../db.js';
import type { Deliver, ReportBatch, ReportingConfig } from './reporting.js';

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const CFG: ReportingConfig = { endpoint: 'https://teams.example.com/ingest', token: 'tok' };

function at(db: DB, ts: number, input: Parameters<typeof recordAudit>[1]): void {
  const e = recordAudit(db, input);
  db.prepare('UPDATE audit_events SET ts = ? WHERE id = ?').run(ts, e.id);
}

function seedDecisions(db: DB, n: number, from = T0): void {
  for (let i = 0; i < n; i++) {
    at(db, from + i, {
      kind: i % 3 === 2 ? 'command_blocked' : 'permission_approved',
      sessionId: 's1',
      summary: 'x',
      payload: { tool: 'Bash', command: `cmd-${i}`, ...(i % 3 === 2 ? { reason: 'denylist' } : {}) },
    });
  }
}

/** Records every batch and answers however the test says. */
function recorder(ok = true): { deliver: Deliver; batches: ReportBatch[] } {
  const batches: ReportBatch[] = [];
  const deliver: Deliver = (_cfg, batch) => {
    batches.push(JSON.parse(JSON.stringify(batch)) as ReportBatch);
    return Promise.resolve(ok ? { ok: true, status: 200 } : { ok: false, error: 'nope' });
  };
  return { deliver, batches };
}

describe('reporting client', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  describe('opt-in', () => {
    it('does nothing at all when not configured', async () => {
      seedDecisions(db, 3);
      const { deliver, batches } = recorder();
      const r = await pushOnce(db, { deliver, config: null });
      expect(r).toMatchObject({ ok: true, sent: 0, skipped: 'not-configured' });
      expect(batches).toEqual([]);
      expect(getCursor(db)).toBe(0); // nothing consumed either
    });

    it('does nothing when configured but disabled', async () => {
      seedDecisions(db, 3);
      const { deliver, batches } = recorder();
      const r = await pushOnce(db, { deliver, config: { ...CFG, enabled: false } });
      expect(r).toMatchObject({ ok: true, sent: 0, skipped: 'disabled' });
      expect(batches).toEqual([]);
    });

    it('reportingEnabled reflects both the config and the flag', () => {
      expect(reportingEnabled(null)).toBe(false);
      expect(reportingEnabled(CFG)).toBe(true);
      expect(reportingEnabled({ ...CFG, enabled: false })).toBe(false);
    });
  });

  describe('what crosses the wire', () => {
    it('sends decisions, and carries the reason a command was blocked', async () => {
      seedDecisions(db, 3);
      const { deliver, batches } = recorder();
      await pushOnce(db, { deliver, config: CFG, now: T0 + 1000 });
      expect(batches).toHaveLength(1);
      expect(batches[0]!.records).toHaveLength(3);
      expect(batches[0]!.records[2]).toMatchObject({ tool: 'Bash', reason: 'denylist' });
    });

    /**
     * The promise on the tin. A record is a fixed shape, and these are the
     * only fields in it — if a prompt or a diff ever reaches this object it
     * will be because someone added a key, and this fails when they do.
     */
    it('carries no field that could hold a prompt, a diff or file contents', async () => {
      seedDecisions(db, 1);
      const { deliver, batches } = recorder();
      await pushOnce(db, { deliver, config: CFG, now: T0 + 1000 });
      const allowed = new Set([
        'ts',
        'decision',
        'tool',
        'detail',
        'reason',
        'sessionId',
        'sessionName',
      ]);
      for (const rec of batches[0]!.records) {
        for (const k of Object.keys(rec)) expect(allowed.has(k)).toBe(true);
      }
      const envelope = new Set([
        'version',
        'deviceId',
        'sentAt',
        'window',
        'redacted',
        'records',
        'chain',
        'signature',
      ]);
      for (const k of Object.keys(batches[0]!)) expect(envelope.has(k)).toBe(true);
    });

    it('redacts commands to fingerprints when asked', async () => {
      seedDecisions(db, 2);
      const { deliver, batches } = recorder();
      await pushOnce(db, { deliver, config: { ...CFG, redact: true }, now: T0 + 1000 });
      expect(batches[0]!.redacted).toBe(true);
      for (const r of batches[0]!.records) expect(r.detail).toMatch(/^fp:[0-9a-f]{16}$/);
    });

    it('signs the batch so the server can tell which device sent it', async () => {
      seedDecisions(db, 2);
      const { deliver, batches } = recorder();
      await pushOnce(db, { deliver, config: CFG, now: T0 + 1000 });
      const b = batches[0]!;
      expect(b.deviceId).toMatch(/^[0-9a-f]{16}$/);
      expect(b.signature).toBeDefined();
      expect(verifyDigestSignature(b.chain.digest, b.signature!)).toBe(true);
      // And the digest genuinely covers the records it shipped.
      expect(chainDigest(b.records, b.window, b.redacted)).toBe(b.chain.digest);
    });

    it('never puts the bearer token in the batch', async () => {
      seedDecisions(db, 2);
      const { deliver, batches } = recorder();
      await pushOnce(db, { deliver, config: CFG, now: T0 + 1000 });
      expect(JSON.stringify(batches[0])).not.toContain('tok');
    });
  });

  describe('the cursor', () => {
    it('advances on success so records are not re-sent', async () => {
      seedDecisions(db, 3);
      const { deliver, batches } = recorder();
      await pushOnce(db, { deliver, config: CFG, now: T0 + 1000 });
      expect(batches[0]!.records).toHaveLength(3);

      // Nothing new, so nothing is delivered at all — an empty POST every
      // interval would be noise on the endpoint and in its logs.
      const second = await pushOnce(db, { deliver, config: CFG, now: T0 + 2000 });
      expect(second).toMatchObject({ ok: true, sent: 0, more: false });
      expect(batches).toHaveLength(1);
    });

    it('picks up only what is new on the next push', async () => {
      seedDecisions(db, 2);
      const { deliver, batches } = recorder();
      await pushOnce(db, { deliver, config: CFG, now: T0 + 1000 });
      seedDecisions(db, 2, T0 + 5000);
      await pushOnce(db, { deliver, config: CFG, now: T0 + 6000 });
      expect(batches[1]!.records.map((r) => r.detail)).toEqual(['cmd-0', 'cmd-1']);
      expect(batches[1]!.records.every((r) => r.ts >= T0 + 5000)).toBe(true);
    });

    /** The property that makes an audit trail trustworthy: nothing is lost. */
    it('does NOT advance when delivery fails, so the records go again', async () => {
      seedDecisions(db, 3);
      const fail = recorder(false);
      const r = await pushOnce(db, { deliver: fail.deliver, config: CFG, now: T0 + 1000 });
      expect(r).toMatchObject({ ok: false, sent: 0, more: true });
      expect(getCursor(db)).toBe(0);

      const good = recorder();
      await pushOnce(db, { deliver: good.deliver, config: CFG, now: T0 + 2000 });
      expect(good.batches[0]!.records).toHaveLength(3);
    });

    it('a repeated failure re-sends the same records, not a growing pile', async () => {
      seedDecisions(db, 3);
      const fail = recorder(false);
      await pushOnce(db, { deliver: fail.deliver, config: CFG, now: T0 + 1000 });
      await pushOnce(db, { deliver: fail.deliver, config: CFG, now: T0 + 2000 });
      expect(fail.batches[0]!.records).toHaveLength(3);
      expect(fail.batches[1]!.records).toHaveLength(3);
    });

    it('moves past an idle window so it is not rescanned forever', async () => {
      const { deliver } = recorder();
      await pushOnce(db, { deliver, config: CFG, now: T0 + 1000 });
      expect(getCursor(db)).toBe(T0 + 1000);
    });
  });

  describe('batching a backlog', () => {
    it('caps one batch and reports there is more', async () => {
      seedDecisions(db, MAX_BATCH + 25);
      const { deliver, batches } = recorder();
      const r = await pushOnce(db, { deliver, config: CFG, now: T0 + 100_000 });
      expect(r).toMatchObject({ ok: true, sent: MAX_BATCH, more: true });
      expect(batches[0]!.records).toHaveLength(MAX_BATCH);
    });

    /**
     * The bug this guards: advancing the cursor to `until` after a capped
     * batch would skip every record between the last one sent and now.
     */
    it('drains the rest on the next push without skipping any', async () => {
      const total = MAX_BATCH + 25;
      seedDecisions(db, total);
      const { deliver, batches } = recorder();
      const r = await push(db, { deliver, config: CFG });
      expect(r).toMatchObject({ ok: true, more: false });
      const seen = batches.flatMap((b) => b.records.map((x) => x.detail));
      expect(new Set(seen).size).toBe(total);
      expect(r.sent).toBe(total);
    });

    it('push stops at the first failure and leaves the remainder queued', async () => {
      seedDecisions(db, 3);
      const fail = recorder(false);
      const r = await push(db, { deliver: fail.deliver, config: CFG });
      expect(r.ok).toBe(false);
      expect(getCursor(db)).toBe(0);
    });
  });

  describe('config on disk', () => {
    it('round-trips, and stays readable only by the owner', () => {
      writeReportingConfig(CFG);
      expect(readReportingConfig()).toMatchObject({ endpoint: CFG.endpoint, token: 'tok' });
      expect(statSync(join(HOME, 'reporting.json')).mode & 0o777).toBe(0o600);
    });

    it('treats an endpoint-less or corrupt file as not configured', () => {
      writeReportingConfig({ endpoint: '  ' });
      expect(readReportingConfig()).toBeNull();
    });
  });

  describe('file: endpoint — a pilot with no server', () => {
    it('appends one JSON line per batch', async () => {
      const out = join(HOME, 'pilot', 'batches.jsonl');
      seedDecisions(db, 2);
      await pushOnce(db, { config: { endpoint: `file:${out}` }, now: T0 + 1000 });
      seedDecisions(db, 1, T0 + 5000);
      await pushOnce(db, { config: { endpoint: `file:${out}` }, now: T0 + 6000 });

      const lines = readFileSync(out, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!) as ReportBatch;
      expect(first.records).toHaveLength(2);
      expect(JSON.parse(lines[1]!).records).toHaveLength(1);
    });
  });

  it('refuses an endpoint that is neither https nor file:', async () => {
    seedDecisions(db, 1);
    const r = await pushOnce(db, { config: { endpoint: 'ftp://nope' }, now: T0 + 1000 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('unsupported endpoint');
    expect(getCursor(db)).toBe(0);
  });

  it('pendingBatch does not send or consume anything', async () => {
    seedDecisions(db, 3);
    const b = pendingBatch(db, CFG, { now: T0 + 1000 });
    expect(b.records).toHaveLength(3);
    expect(getCursor(db)).toBe(0);
    const { deliver, batches } = recorder();
    await pushOnce(db, { deliver, config: CFG, now: T0 + 1000 });
    expect(batches[0]!.records).toHaveLength(3); // still there to send
  });
});
