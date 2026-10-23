import { nanoid } from 'nanoid';
import type { AuditEvent, AuditKind } from '@solix/shared';
import type { DB } from '../db.js';

interface AuditRow {
  id: string;
  ts: number;
  kind: AuditKind;
  session_id: string | null;
  advisor_id: string | null;
  project_id: string | null;
  summary: string;
  payload_json: string | null;
}

function rowToAuditEvent(row: AuditRow): AuditEvent {
  let payload: Record<string, unknown> | undefined;
  if (row.payload_json) {
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      payload = undefined;
    }
  }
  return {
    id: row.id,
    ts: row.ts,
    kind: row.kind,
    sessionId: row.session_id ?? undefined,
    advisorId: row.advisor_id ?? undefined,
    projectId: row.project_id ?? undefined,
    summary: row.summary,
    payload,
  };
}

export interface RecordAuditInput {
  kind: AuditKind;
  summary: string;
  sessionId?: string;
  advisorId?: string;
  projectId?: string;
  payload?: Record<string, unknown>;
}

export function recordAudit(db: DB, input: RecordAuditInput): AuditEvent {
  const event: AuditEvent = {
    id: nanoid(),
    ts: Date.now(),
    kind: input.kind,
    sessionId: input.sessionId,
    advisorId: input.advisorId,
    projectId: input.projectId,
    summary: input.summary,
    payload: input.payload,
  };
  db.prepare(
    `INSERT INTO audit_events
       (id, ts, kind, session_id, advisor_id, project_id, summary, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.ts,
    event.kind,
    event.sessionId ?? null,
    event.advisorId ?? null,
    event.projectId ?? null,
    event.summary,
    event.payload ? JSON.stringify(event.payload) : null,
  );
  return event;
}

export interface ListAuditOptions {
  sessionId?: string;
  kind?: AuditKind;
  since?: number;
  until?: number;
  limit?: number;
}

export function listAudit(
  db: DB,
  opts: ListAuditOptions = {},
): AuditEvent[] {
  const limit = Math.min(opts.limit ?? 200, 1000);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.sessionId) {
    where.push('session_id = ?');
    params.push(opts.sessionId);
  }
  if (opts.kind) {
    where.push('kind = ?');
    params.push(opts.kind);
  }
  if (typeof opts.since === 'number') {
    where.push('ts >= ?');
    params.push(opts.since);
  }
  if (typeof opts.until === 'number') {
    where.push('ts <= ?');
    params.push(opts.until);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT * FROM audit_events ${whereClause}
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .all(...params, limit) as AuditRow[];
  return rows.map(rowToAuditEvent);
}

/**
 * What Solix actually prevented, over a window.
 *
 * Solix is the only tool in this space that intercepts the call, so it is
 * the only one that can report what *didn't* happen. Everything here is
 * already in `audit_events` — this aggregates it rather than collecting
 * anything new, and it never leaves the machine unless the user copies it.
 *
 * `blockedByContainment` counts refusals the denylist made on its own, which
 * is deliberately separate from `denied`: a command a human looked at and
 * refused is a different fact from one that never reached them.
 */
export interface ImpactSummary {
  sinceMs: number;
  untilMs: number;
  approved: number;
  denied: number;
  blockedByContainment: number;
  /** Distinct reasons the denylist fired, commonest first. */
  blockReasons: { reason: string; count: number }[];
  budgetPauses: number;
  /** Spend at the moment each plan paused — what the caps were holding. */
  spendAtPauseUsd: number;
  advisorInvocations: number;
  sessionsTerminated: number;
}

export function summarizeImpact(
  db: DB,
  opts: { since?: number; until?: number } = {},
): ImpactSummary {
  const until = opts.until ?? Date.now();
  // Default window: 30 days. Long enough to be a story, short enough that it
  // reads as "recently" rather than "since forever".
  const since = opts.since ?? until - 30 * 24 * 60 * 60 * 1000;

  const countOf = (kind: AuditKind): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM audit_events
           WHERE kind = ? AND ts >= ? AND ts <= ?`,
        )
        .get(kind, since, until) as { n: number }
    ).n;

  const blocked = db
    .prepare(
      `SELECT payload_json FROM audit_events
       WHERE kind = 'command_blocked' AND ts >= ? AND ts <= ?`,
    )
    .all(since, until) as { payload_json: string | null }[];

  const reasonCounts = new Map<string, number>();
  for (const row of blocked) {
    if (!row.payload_json) continue;
    try {
      const reason = (JSON.parse(row.payload_json) as { reason?: string }).reason;
      if (reason) reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    } catch {
      /* a malformed payload should not lose the count above */
    }
  }

  const pauses = db
    .prepare(
      `SELECT payload_json FROM audit_events
       WHERE kind = 'budget_paused' AND ts >= ? AND ts <= ?`,
    )
    .all(since, until) as { payload_json: string | null }[];

  let spendAtPauseUsd = 0;
  for (const row of pauses) {
    if (!row.payload_json) continue;
    try {
      const spent = (JSON.parse(row.payload_json) as { spentUsd?: number }).spentUsd;
      if (typeof spent === 'number' && isFinite(spent)) spendAtPauseUsd += spent;
    } catch {
      /* ignore */
    }
  }

  return {
    sinceMs: since,
    untilMs: until,
    approved: countOf('permission_approved'),
    denied: countOf('permission_denied'),
    blockedByContainment: blocked.length,
    blockReasons: [...reasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count),
    budgetPauses: pauses.length,
    spendAtPauseUsd,
    advisorInvocations: countOf('advisor_invoked'),
    sessionsTerminated: countOf('session_terminated'),
  };
}
