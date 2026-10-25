/**
 * The reporting client — increment 1 of Solix Teams (`docs/TEAMS-SPEC.md`).
 *
 * Sends decision records to a server the *company* runs. Three properties
 * hold it to the promise on the tin, and none of them are optional:
 *
 * 1. **Opt-in.** No configured endpoint means no network call, ever. This is
 *    the default and nothing in Solix turns it on for you.
 * 2. **It sees what you approved, not what you built.** Decisions,
 *    containment blocks and spend go. Prompts, completions, diffs and file
 *    contents do not — there is no code path here that can read them.
 * 3. **It never blocks an agent.** Delivery is out of band and failure is
 *    inert: the cursor does not advance, so records wait and go later.
 *
 * ## audit_events is the queue
 *
 * There is no separate outbox table. The audit log is already append-only and
 * ordered, so "pending" is everything at or after a stored high-water mark,
 * and delivery is just advancing that mark. A crash mid-send re-sends rather
 * than drops — the batch is idempotent on event identity, so the duplicate is
 * the server's no-op rather than our problem. Losing a record is unacceptable
 * in an audit trail; sending one twice is free.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { DB } from '../db.js';
import { SOLIX_HOME } from '../paths.js';
import { getSetting, setSetting } from './orgs.js';
import {
  chainDigest,
  collectRecords,
  deviceId,
  signDigest,
  type FleetReport,
  type ReportRecord,
} from './report.js';

export const REPORTING_CONFIG_PATH = join(SOLIX_HOME, 'reporting.json');
const CURSOR_KEY = 'reporting.cursorTs';

/** Most records in one batch. A long backlog drains over several pushes. */
export const MAX_BATCH = 500;

export interface ReportingConfig {
  /** `https://host/path` to POST to, or `file:/abs/path.jsonl` to append to. */
  endpoint: string;
  /** Bearer token for an http endpoint. Never logged, never printed. */
  token?: string;
  /** Send fingerprints instead of command text. */
  redact?: boolean;
  /** How often the server pushes, when it is running. Default 5 minutes. */
  intervalMs?: number;
  /** Set false to keep the config but stop sending. */
  enabled?: boolean;
}

export interface ReportBatch {
  version: 1;
  /** Which machine this came from — derived from the device signing key. */
  deviceId: string | null;
  sentAt: number;
  window: { since: number; until: number };
  redacted: boolean;
  records: ReportRecord[];
  chain: { algorithm: 'sha256-chain'; digest: string };
  signature?: FleetReport['signature'];
}

/** Read the config, or null when reporting was never set up. */
export function readReportingConfig(): ReportingConfig | null {
  try {
    if (!existsSync(REPORTING_CONFIG_PATH)) return null;
    const cfg = JSON.parse(readFileSync(REPORTING_CONFIG_PATH, 'utf8')) as ReportingConfig;
    return typeof cfg?.endpoint === 'string' && cfg.endpoint.trim() ? cfg : null;
  } catch {
    return null;
  }
}

/** Reporting is on only when a config exists AND was not disabled. */
export function reportingEnabled(cfg = readReportingConfig()): boolean {
  return cfg !== null && cfg.enabled !== false;
}

export function writeReportingConfig(cfg: ReportingConfig): ReportingConfig {
  mkdirSync(dirname(REPORTING_CONFIG_PATH), { recursive: true });
  // 0600: it holds a bearer token.
  writeFileSync(REPORTING_CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return cfg;
}

export function getCursor(db: DB): number {
  const raw = getSetting(db, CURSOR_KEY);
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

export function setCursor(db: DB, ts: number): void {
  setSetting(db, CURSOR_KEY, String(ts));
}

/**
 * Build the next batch without sending it.
 *
 * `until` is clamped to now, and the window starts at the cursor inclusive so
 * an event sharing a timestamp with the last delivered one is re-sent rather
 * than skipped. That duplicate is the price of never dropping a record.
 */
export function pendingBatch(
  db: DB,
  cfg: ReportingConfig,
  opts: { now?: number } = {},
): ReportBatch {
  const until = opts.now ?? Date.now();
  const since = getCursor(db);
  const redacted = cfg.redact ?? false;
  // Oldest first: a capped batch must take the FRONT of the queue. Taking the
  // newest MAX_BATCH and then advancing the cursor past them would step over
  // every older record still waiting — silent loss from an audit trail.
  const records = collectRecords(db, {
    since,
    until,
    redact: redacted,
    limit: MAX_BATCH,
    oldestFirst: true,
  });
  const window = { since, until };
  const digest = chainDigest(records, window, redacted);
  const batch: ReportBatch = {
    version: 1,
    deviceId: deviceId(),
    sentAt: until,
    window,
    redacted,
    records,
    chain: { algorithm: 'sha256-chain', digest },
  };
  const signature = signDigest(digest);
  if (signature) batch.signature = signature;
  return batch;
}

export type Deliver = (
  cfg: ReportingConfig,
  batch: ReportBatch,
) => Promise<{ ok: boolean; status?: number; error?: string }>;

/**
 * Default transport. `file:` exists so a pilot can run with no server at all —
 * point it at a path, let it fill, and look at what a fleet view would have
 * to show before building one.
 */
export const deliver: Deliver = async (cfg, batch) => {
  const endpoint = cfg.endpoint.trim();
  if (endpoint.startsWith('file:')) {
    try {
      const path = endpoint.slice('file:'.length);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(batch)}\n`, 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
  if (!/^https?:\/\//.test(endpoint)) {
    return { ok: false, error: `unsupported endpoint "${endpoint}" — use https:// or file:/path` };
  }
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(batch),
    });
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `endpoint answered ${res.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
};

export interface PushResult {
  ok: boolean;
  /** Records handed to the endpoint. Zero is a success, not a failure. */
  sent: number;
  /** True when more remain — call again to drain. */
  more: boolean;
  error?: string;
  skipped?: 'not-configured' | 'disabled';
}

/**
 * Send one batch and advance the cursor on success.
 *
 * The cursor moves to the newest record actually sent, never to `until` —
 * otherwise a batch capped at MAX_BATCH would silently skip everything
 * between the last record sent and now.
 */
export async function pushOnce(
  db: DB,
  deps: { deliver?: Deliver; config?: ReportingConfig | null; now?: number } = {},
): Promise<PushResult> {
  const cfg = deps.config ?? readReportingConfig();
  if (!cfg) return { ok: true, sent: 0, more: false, skipped: 'not-configured' };
  if (cfg.enabled === false) return { ok: true, sent: 0, more: false, skipped: 'disabled' };

  const batch = pendingBatch(db, cfg, { now: deps.now });
  if (batch.records.length === 0) {
    // Nothing to say. Move the cursor up so an idle machine does not rescan
    // the same empty window forever.
    setCursor(db, batch.window.until);
    return { ok: true, sent: 0, more: false };
  }

  const res = await (deps.deliver ?? deliver)(cfg, batch);
  if (!res.ok) {
    // Cursor untouched: these records go again next time.
    return { ok: false, sent: 0, more: true, error: res.error ?? 'delivery failed' };
  }

  const newest = batch.records.reduce((m, r) => Math.max(m, r.ts), 0);
  const more = batch.records.length >= MAX_BATCH;
  // +1 so the record at `newest` is not re-sent on every subsequent push.
  setCursor(db, more ? newest + 1 : batch.window.until);
  return { ok: true, sent: batch.records.length, more };
}

/**
 * Drain the backlog, up to `maxBatches` so a huge history cannot occupy the
 * process indefinitely. Stops at the first failure and leaves the rest queued.
 */
export async function push(
  db: DB,
  deps: { deliver?: Deliver; config?: ReportingConfig | null; maxBatches?: number } = {},
): Promise<PushResult> {
  const max = deps.maxBatches ?? 20;
  let sent = 0;
  for (let i = 0; i < max; i++) {
    const r = await pushOnce(db, deps);
    if (r.skipped) return r;
    sent += r.sent;
    if (!r.ok) return { ...r, sent };
    if (!r.more) return { ok: true, sent, more: false };
  }
  return { ok: true, sent, more: true };
}
