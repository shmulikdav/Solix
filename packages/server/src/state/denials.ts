import { nanoid } from 'nanoid';
import type { DB } from '../db.js';
import { listAudit } from './audit.js';

/**
 * A command a person denied, remembered for one plan.
 *
 * Measured on 1.18.3: a Maestro worker was denied a command, the verifier
 * rejected the task for not doing it, the orchestrator retried, and the same
 * command was put to the person again — the gate asking a question it had
 * already been answered. A denial is a decision, not a transient failure, so
 * the router re-applies it to an identical command from the same plan without
 * asking a second time.
 *
 * Scoped to the plan on purpose: a person saying no to `rm -rf build` in one
 * plan has not said anything about another plan, or about the same command
 * typed by hand. Rows are removed with the plan (ON-cascade is done in
 * deletePlan, which already clears the plan's other child rows).
 */
export interface PlanDenial {
  id: string;
  planId: string;
  tool: string;
  matchValue: string;
  sessionId?: string;
  createdAt: number;
}

interface PlanDenialRow {
  id: string;
  plan_id: string;
  tool: string;
  match_value: string;
  session_id: string | null;
  created_at: number;
}

/**
 * The key a denial is matched on: the thing a person actually looked at. A
 * shell command by its text (whitespace collapsed so a reformat is still the
 * same command), a file tool by its path, anything else by a stable dump of
 * its arguments. Deliberately exact — this re-applies a *specific* refusal,
 * not a class of them. Broadening "no to this" into "no to everything like
 * it" is what an approval rule is for, and that is a separate, visible choice.
 */
export function stickyKeyFor(tool: string, args: Record<string, unknown>): string {
  if (typeof args.command === 'string' && args.command.trim()) {
    return args.command.replace(/\s+/g, ' ').trim();
  }
  if (typeof args.file_path === 'string' && args.file_path) {
    return args.file_path;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

export function recordPlanDenial(
  db: DB,
  input: { planId: string; tool: string; matchValue: string; sessionId?: string },
): PlanDenial {
  const existing = db
    .prepare(
      'SELECT * FROM plan_denials WHERE plan_id = ? AND tool = ? AND match_value = ?',
    )
    .get(input.planId, input.tool, input.matchValue) as PlanDenialRow | undefined;
  if (existing) return rowToDenial(existing);
  const row: PlanDenialRow = {
    id: nanoid(),
    plan_id: input.planId,
    tool: input.tool,
    match_value: input.matchValue,
    session_id: input.sessionId ?? null,
    created_at: Date.now(),
  };
  db.prepare(
    `INSERT INTO plan_denials (id, plan_id, tool, match_value, session_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.plan_id, row.tool, row.match_value, row.session_id, row.created_at);
  return rowToDenial(row);
}

/** The denial that re-applies to this call, if a person made one for this plan. */
export function matchingPlanDenial(
  db: DB,
  planId: string,
  tool: string,
  matchValue: string,
): PlanDenial | null {
  const row = db
    .prepare(
      'SELECT * FROM plan_denials WHERE plan_id = ? AND tool = ? AND match_value = ?',
    )
    .get(planId, tool, matchValue) as PlanDenialRow | undefined;
  return row ? rowToDenial(row) : null;
}

export function listPlanDenials(db: DB, planId: string): PlanDenial[] {
  const rows = db
    .prepare('SELECT * FROM plan_denials WHERE plan_id = ? ORDER BY created_at ASC')
    .all(planId) as PlanDenialRow[];
  return rows.map(rowToDenial);
}

export function clearPlanDenials(db: DB, planId: string): number {
  return db.prepare('DELETE FROM plan_denials WHERE plan_id = ?').run(planId).changes;
}

/**
 * Did a *person* deny a command to this session, and which one?
 *
 * Distinguishes the three shapes a `permission_denied` row can take, because
 * only one of them should stop a retry:
 *  - a person pressed Deny → `payload.timedOut` and `payload.abandoned` both
 *    absent. This is the one we act on.
 *  - the gate timed out with nobody answering → `payload.timedOut`.
 *  - Solix was shutting down and dropped the hold → `payload.abandoned`.
 * A rule or a sticky denial records `permission_auto_denied`, a different
 * kind, so it never reaches this query.
 *
 * Returns the denied command/path, or undefined if a person denied nothing
 * to this session.
 */
export function humanDeniedDetail(db: DB, sessionId: string): string | undefined {
  const rows = listAudit(db, { sessionId, kind: 'permission_denied', limit: 50 });
  for (const e of rows) {
    const payload = e.payload ?? {};
    if (payload.timedOut || payload.abandoned) continue;
    const args = (payload.args as Record<string, unknown> | undefined) ?? {};
    if (typeof payload.command === 'string') return payload.command;
    if (typeof args.command === 'string') return args.command;
    if (typeof args.file_path === 'string') return args.file_path;
    return typeof payload.tool === 'string' ? payload.tool : 'a command';
  }
  return undefined;
}

/** Was this session's hold dropped because Solix was shutting down? */
export function sessionHoldWasAbandoned(db: DB, sessionId: string): boolean {
  const rows = listAudit(db, { sessionId, kind: 'permission_denied', limit: 50 });
  return rows.some((e) => (e.payload ?? {}).abandoned === true);
}

function rowToDenial(row: PlanDenialRow): PlanDenial {
  return {
    id: row.id,
    planId: row.plan_id,
    tool: row.tool,
    matchValue: row.match_value,
    sessionId: row.session_id ?? undefined,
    createdAt: row.created_at,
  };
}
