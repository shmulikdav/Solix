/**
 * `solix report` — a tamper-evident record of what the fleet was allowed to do.
 *
 * `gain` counts what was stopped and `ledger` lists what got through. Both are
 * for you, and both are trivially editable text. This is the artifact you hand
 * to someone else: the same facts, plus a hash chain and a signature, so the
 * person reading it can tell whether it changed after it was produced.
 *
 * It is also increment 0 of Solix Teams (`docs/TEAMS-SPEC.md`) — deliberately
 * the whole payload Teams would later aggregate, so the wire format gets
 * exercised by a real artifact before any server depends on it.
 *
 * ## What the signature does and does not prove
 *
 * The key is generated on this machine and stays on it. So a verified report
 * proves exactly one thing:
 *
 *   **this file has not been altered since the machine produced it.**
 *
 * It does NOT prove the machine reported honestly. Whoever holds the private
 * key can produce a different report and sign that instead. Against a careless
 * edit, a copy-paste slip or an accidental truncation it is real evidence;
 * against the key's owner it is not, and nothing local-only could be. Trusting
 * a report across machines means getting the public key out of band, which is
 * what the Teams server does by enrolling devices.
 *
 * Say this plainly wherever the report is shown. A security claim that
 * overstates itself is worse than none.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { DB } from '../db.js';
import { SOLIX_HOME } from '../paths.js';
import { summarizeImpact, type ImpactSummary } from './audit.js';
import { listLedger, type LedgerDecision, type LedgerEntry } from './ledger.js';

export const REPORT_VERSION = 1 as const;

/** Where the device keypair lives. Private key is 0600; public sits beside it. */
export const REPORT_KEY_PATH = join(SOLIX_HOME, 'report-key');
const REPORT_PUBKEY_PATH = `${REPORT_KEY_PATH}.pub`;

export interface ReportRecord {
  ts: number;
  decision: LedgerDecision;
  tool: string;
  /** The command/path, or `fp:<16 hex>` when the report was redacted. */
  detail: string;
  reason?: string;
  sessionId?: string;
  sessionName?: string;
}

export interface FleetReport {
  version: typeof REPORT_VERSION;
  generatedAt: number;
  window: { since: number; until: number };
  /** True when `detail` holds fingerprints rather than the commands. */
  redacted: boolean;
  summary: ImpactSummary;
  records: ReportRecord[];
  chain: { algorithm: 'sha256-chain'; digest: string };
  signature?: { algorithm: 'ed25519'; publicKey: string; value: string };
}

/** Stable fingerprint of a command, for `--redact`. */
export function fingerprint(detail: string): string {
  return `fp:${createHash('sha256').update(detail, 'utf8').digest('hex').slice(0, 16)}`;
}

/**
 * One record, rendered to the exact bytes that go into the chain.
 *
 * Hand-built rather than JSON.stringify'd: key order in an object literal is
 * an implementation detail, and a digest that depends on it would break the
 * moment a field is reordered. Field order here is explicit and append-only —
 * new fields go on the end, never in the middle, or every previously issued
 * report stops verifying.
 */
function canonical(r: ReportRecord): string {
  return [
    r.ts,
    r.decision,
    r.tool,
    r.detail,
    r.reason ?? '',
    r.sessionId ?? '',
    r.sessionName ?? '',
  ].join('\u001f');
}

/**
 * Fold the records into a single digest, each link covering the one before it.
 *
 * Seeded with the version and window so two reports over different windows
 * can never collide, and so truncating a report to its first N records
 * produces a different digest than a report genuinely covering fewer events.
 */
export function chainDigest(
  records: ReportRecord[],
  window: { since: number; until: number },
  redacted: boolean,
): string {
  let h = createHash('sha256')
    .update(`solix-report/v${REPORT_VERSION}/${window.since}-${window.until}/${redacted ? 'redacted' : 'full'}`)
    .digest('hex');
  for (const r of records) {
    h = createHash('sha256').update(`${h}\u001e${canonical(r)}`).digest('hex');
  }
  return h;
}

/**
 * A stable identity for this machine: the first 16 hex of the device public
 * key's digest. Derived from the key rather than stored separately so the two
 * can never disagree — a report's signature and the id it was filed under
 * always refer to the same keypair.
 */
export function deviceId(): string | null {
  const key = deviceKey();
  if (!key) return null;
  return createHash('sha256').update(key.publicPem.trim()).digest('hex').slice(0, 16);
}

/** Sign a chain digest with the device key. Undefined if the key is unusable. */
export function signDigest(digest: string): FleetReport['signature'] {
  const key = deviceKey();
  if (!key) return undefined;
  try {
    return {
      algorithm: 'ed25519',
      publicKey: key.publicPem.trim(),
      value: sign(null, Buffer.from(digest, 'hex'), createPrivateKey(key.privatePem)).toString(
        'base64',
      ),
    };
  } catch {
    return undefined;
  }
}

/** Check a signature against a digest. */
export function verifyDigestSignature(
  digest: string,
  signature: NonNullable<FleetReport['signature']>,
): boolean {
  try {
    return verify(
      null,
      Buffer.from(digest, 'hex'),
      createPublicKey(signature.publicKey),
      Buffer.from(signature.value, 'base64'),
    );
  } catch {
    return false;
  }
}

/** The decision records in a window, ordered and optionally redacted. */
export function collectRecords(
  db: DB,
  opts: {
    since: number;
    until: number;
    redact?: boolean;
    limit?: number;
    /** Keep the oldest `limit` rather than the newest — see `listLedger`. */
    oldestFirst?: boolean;
  },
): ReportRecord[] {
  return order(
    listLedger(db, {
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      ...(opts.oldestFirst ? { oldestFirst: true } : {}),
    }),
    opts.redact ?? false,
  );
}

/** Records in a fixed order, so the same window always yields the same digest. */
function order(entries: LedgerEntry[], redacted: boolean): ReportRecord[] {
  return entries
    .map((e) => ({
      ts: e.ts,
      decision: e.decision,
      tool: e.tool,
      detail: redacted ? fingerprint(e.detail) : e.detail,
      ...(e.reason ? { reason: e.reason } : {}),
      ...(e.sessionId ? { sessionId: e.sessionId } : {}),
      ...(e.sessionName ? { sessionName: e.sessionName } : {}),
    }))
    .sort((a, b) => a.ts - b.ts || canonical(a).localeCompare(canonical(b)));
}

/**
 * Load the device keypair, creating it on first use.
 *
 * Returns null if the key cannot be read or written — a report without a
 * signature is still a useful report, and a machine with a read-only home
 * directory should get one rather than an error.
 */
export function deviceKey(): { privatePem: string; publicPem: string } | null {
  try {
    if (existsSync(REPORT_KEY_PATH) && existsSync(REPORT_PUBKEY_PATH)) {
      return {
        privatePem: readFileSync(REPORT_KEY_PATH, 'utf8'),
        publicPem: readFileSync(REPORT_PUBKEY_PATH, 'utf8'),
      };
    }
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    mkdirSync(dirname(REPORT_KEY_PATH), { recursive: true });
    writeFileSync(REPORT_KEY_PATH, privatePem, { mode: 0o600 });
    writeFileSync(REPORT_PUBKEY_PATH, publicPem, { mode: 0o644 });
    // writeFileSync's mode is subject to umask; be explicit about the private key.
    chmodSync(REPORT_KEY_PATH, 0o600);
    return { privatePem, publicPem };
  } catch {
    return null;
  }
}

export interface BuildReportOptions {
  since?: number;
  until?: number;
  redact?: boolean;
  /** Skip signing (and key creation). The chain digest is still computed. */
  unsigned?: boolean;
}

export function buildReport(db: DB, opts: BuildReportOptions = {}): FleetReport {
  const until = opts.until ?? Date.now();
  const since = opts.since ?? until - 30 * 24 * 60 * 60 * 1000;
  const redacted = opts.redact ?? false;

  const records = collectRecords(db, { since, until, redact: redacted });
  const summary = summarizeImpact(db, { since, until });
  const digest = chainDigest(records, { since, until }, redacted);

  const report: FleetReport = {
    version: REPORT_VERSION,
    generatedAt: Date.now(),
    window: { since, until },
    redacted,
    summary,
    records,
    chain: { algorithm: 'sha256-chain', digest },
  };

  if (!opts.unsigned) {
    // Unsigned rather than failed when the key is unusable — see deviceKey().
    const signature = signDigest(digest);
    if (signature) report.signature = signature;
  }
  return report;
}

export type VerifyResult =
  | { ok: true; signed: boolean }
  | { ok: false; reason: string };

/**
 * Recompute the chain and check the signature.
 *
 * Deliberately recomputes from `records` rather than trusting `chain.digest`,
 * so editing a record and leaving the digest alone fails, and editing both
 * fails on the signature.
 */
export function verifyReport(report: FleetReport): VerifyResult {
  if (report.version !== REPORT_VERSION) {
    return { ok: false, reason: `unsupported report version ${String(report.version)}` };
  }
  if (!Array.isArray(report.records) || !report.window || !report.chain) {
    return { ok: false, reason: 'report is missing records, window or chain' };
  }
  const recomputed = chainDigest(report.records, report.window, report.redacted);
  if (recomputed !== report.chain.digest) {
    return { ok: false, reason: 'the records do not match the digest — this report was altered' };
  }
  if (!report.signature) return { ok: true, signed: false };
  try {
    const good = verify(
      null,
      Buffer.from(recomputed, 'hex'),
      createPublicKey(report.signature.publicKey),
      Buffer.from(report.signature.value, 'base64'),
    );
    return good
      ? { ok: true, signed: true }
      : { ok: false, reason: 'the signature does not match the digest' };
  } catch {
    return { ok: false, reason: 'the signature could not be checked (malformed key or value)' };
  }
}

const iso = (ts: number): string =>
  new Date(ts).toISOString().replace('T', ' ').slice(0, 19);

export function reportToMarkdown(report: FleetReport): string {
  const s = report.summary;
  const lines: string[] = [
    '# Solix fleet report',
    '',
    `**Window:** ${iso(report.window.since)} — ${iso(report.window.until)} (UTC)  `,
    `**Generated:** ${iso(report.generatedAt)} (UTC)  `,
    `**Decisions:** ${report.records.length}${report.redacted ? ' · commands redacted to fingerprints' : ''}`,
    '',
    '## Summary',
    '',
    '| | |',
    '|---|---|',
    `| Approved by a person | ${s.approved} |`,
    `| Denied by a person | ${s.denied} |`,
    `| Blocked by containment | ${s.blockedByContainment} |`,
    `| Plans paused on budget | ${s.budgetPauses} |`,
    `| Spend held at those pauses | $${s.spendAtPauseUsd.toFixed(2)} |`,
    `| Sessions terminated | ${s.sessionsTerminated} |`,
    '',
  ];

  if (s.blockReasons.length > 0) {
    lines.push('### What containment refused', '', '| Rule | Times |', '|---|---|');
    for (const b of s.blockReasons) lines.push(`| ${b.reason.replace(/\|/g, '\\|')} | ${b.count} |`);
    lines.push('');
  }

  lines.push('## Decisions', '');
  if (report.records.length === 0) {
    lines.push('_No decisions in this window._', '');
  } else {
    lines.push('| When (UTC) | Outcome | Tool | Detail | Session |', '|---|---|---|---|---|');
    for (const r of report.records) {
      const esc = (v: string): string => v.replace(/\|/g, '\\|');
      lines.push(
        `| ${iso(r.ts)} | ${r.decision}${r.reason ? ` (${esc(r.reason)})` : ''} | ${esc(r.tool)} | \`${esc(r.detail)}\` | ${esc(r.sessionName ?? r.sessionId ?? '—')} |`,
      );
    }
    lines.push('');
  }

  lines.push(
    '## Integrity',
    '',
    `- **Chain:** \`${report.chain.algorithm}\``,
    `- **Digest:** \`${report.chain.digest}\``,
  );
  if (report.signature) {
    lines.push(
      `- **Signature:** \`${report.signature.algorithm}\``,
      '',
      '<details><summary>Device public key</summary>',
      '',
      '```',
      report.signature.publicKey,
      '```',
      '',
      '</details>',
    );
  } else {
    lines.push('- **Signature:** none — this report is unsigned.');
  }
  lines.push(
    '',
    '> Verify with `solix report --verify <file>`.',
    '>',
    '> **What this proves:** the file has not been altered since the machine',
    '> produced it. **What it does not prove:** that the machine reported',
    '> honestly — the signing key is held by that machine. Treat it as',
    '> protection against accidental edits and truncation, not against the',
    '> key holder.',
    '',
  );
  return lines.join('\n');
}

export function reportToCsv(report: FleetReport): string {
  // RFC 4180: quote everything, double embedded quotes.
  const q = (v: string | number): string => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [
    ['timestamp_utc', 'epoch_ms', 'outcome', 'reason', 'tool', 'detail', 'session'].map(q).join(','),
  ];
  for (const r of report.records) {
    rows.push(
      [
        q(iso(r.ts)),
        q(r.ts),
        q(r.decision),
        q(r.reason ?? ''),
        q(r.tool),
        q(r.detail),
        q(r.sessionName ?? r.sessionId ?? ''),
      ].join(','),
    );
  }
  return `${rows.join('\n')}\n`;
}
