import { spawnSync } from 'node:child_process';
import type {
  AgentRuntime,
  Model,
  Session,
  SessionKind,
  SessionOrigin,
  SessionRole,
  SessionStatus,
} from '@solix/shared';
import type { DB } from '../db.js';
import { now } from '../util.js';

interface SessionRow {
  id: string;
  pid: number | null;
  project_id: string;
  parent_session_id: string | null;
  origin: SessionOrigin;
  model: string | null;
  status: SessionStatus;
  context_usage_pct: number;
  orbit_slot: number;
  cwd: string;
  name: string | null;
  kind: SessionKind | null;
  advisor_role: string | null;
  worktree_path: string | null;
  wrapper_socket_path: string | null;
  agent_view_id: string | null;
  agent_view_summary: string | null;
  pr_url: string | null;
  pr_check_status: string | null;
  cost_usd: number | null;
  budget_usd: number | null;
  current_goal_id: string | null;
  current_mission_id: string | null;
  last_completed_mission_id: string | null;
  plan_id: string | null;
  plan_task_id: string | null;
  session_role: string | null;
  gate_level_at_launch: string | null;
  runtime: string | null;
  created_at: number;
  updated_at: number;
  terminated_at: number | null;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    pid: row.pid ?? 0,
    cwd: row.cwd,
    projectId: row.project_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    model: (row.model ?? 'default') as Model,
    origin: row.origin,
    kind: row.kind ?? 'user',
    advisorRole: row.advisor_role ?? undefined,
    parentSessionId: row.parent_session_id ?? undefined,
    // The column is `REAL DEFAULT 0` and predates nullability, so a stored
    // 0 is a row nothing has measured — a real session with any usage at all
    // reports a percentage above zero. Mapping it here avoids a migration and
    // keeps "no data" distinguishable from "empty context".
    contextUsagePct:
      typeof row.context_usage_pct === 'number' && row.context_usage_pct > 0
        ? row.context_usage_pct
        : null,
    currentMissionId: row.current_mission_id ?? undefined,
    lastCompletedMissionId: row.last_completed_mission_id ?? undefined,
    orbitSlot: row.orbit_slot,
    name: row.name ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    wrapperSocketPath: row.wrapper_socket_path ?? undefined,
    agentViewId: row.agent_view_id ?? undefined,
    agentViewSummary: row.agent_view_summary ?? undefined,
    prUrl: row.pr_url ?? undefined,
    prCheckStatus:
      (row.pr_check_status as
        | 'pending'
        | 'success'
        | 'failure'
        | 'neutral'
        | null) ?? undefined,
    costUsd: row.cost_usd ?? 0,
    budgetUsd: row.budget_usd ?? undefined,
    currentGoalId: row.current_goal_id ?? undefined,
    planId: row.plan_id ?? undefined,
    planTaskId: row.plan_task_id ?? undefined,
    sessionRole: (row.session_role as SessionRole | null) ?? undefined,
    gateLevelAtLaunch:
      (row.gate_level_at_launch as import('@solix/shared').GovernanceLevel | null) ??
      undefined,
    runtime: (row.runtime as AgentRuntime | null) ?? undefined,
  };
}

function nextOrbitSlot(db: DB, projectId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(orbit_slot), -1) AS max_slot
       FROM sessions
       WHERE project_id = ? AND parent_session_id IS NULL
         AND status NOT IN ('terminated')`,
    )
    .get(projectId) as { max_slot: number };
  return (row.max_slot ?? -1) + 1;
}

export interface CreateSessionInput {
  id: string;
  pid: number;
  projectId: string;
  cwd: string;
  origin: SessionOrigin;
  model?: Model;
  parentSessionId?: string;
  kind?: SessionKind;
  advisorRole?: string;
  worktreePath?: string;
  wrapperSocketPath?: string;
  agentViewId?: string;
  agentViewSummary?: string;
  prUrl?: string;
  prCheckStatus?: 'pending' | 'success' | 'failure' | 'neutral';
  /** v2 Maestro — set when the orchestrator pre-creates a worker/verifier row. */
  planId?: string;
  planTaskId?: string;
  sessionRole?: SessionRole;
  gateLevelAtLaunch?: import('@solix/shared').GovernanceLevel;
  runtime?: AgentRuntime;
}

export function upsertSession(db: DB, input: CreateSessionInput): Session {
  const ts = now();
  const existing = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(input.id) as SessionRow | undefined;

  if (existing) {
    db.prepare(
      `UPDATE sessions
       SET pid = ?, status = CASE WHEN status = 'terminated' THEN 'idle' ELSE status END,
           updated_at = ?
       WHERE id = ?`,
    ).run(input.pid, ts, input.id);
    return rowToSession({
      ...existing,
      pid: input.pid,
      updated_at: ts,
    });
  }

  const orbitSlot = input.parentSessionId
    ? 0
    : nextOrbitSlot(db, input.projectId);
  const status: SessionStatus = 'idle';
  const kind: SessionKind = input.kind ?? 'user';

  db.prepare(
    `INSERT INTO sessions (
       id, pid, project_id, parent_session_id, origin, model, status,
       context_usage_pct, orbit_slot, cwd, name, kind, advisor_role,
       worktree_path, wrapper_socket_path,
       agent_view_id, agent_view_summary, pr_url, pr_check_status,
       plan_id, plan_task_id, session_role, gate_level_at_launch,
       runtime,
       created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.pid,
    input.projectId,
    input.parentSessionId ?? null,
    input.origin,
    input.model ?? 'default',
    status,
    orbitSlot,
    input.cwd,
    kind,
    input.advisorRole ?? null,
    input.worktreePath ?? null,
    input.wrapperSocketPath ?? null,
    input.agentViewId ?? null,
    input.agentViewSummary ?? null,
    input.prUrl ?? null,
    input.prCheckStatus ?? null,
    input.planId ?? null,
    input.planTaskId ?? null,
    input.sessionRole ?? null,
    input.gateLevelAtLaunch ?? null,
    input.runtime ?? 'claude',
    ts,
    ts,
  );

  return {
    id: input.id,
    pid: input.pid,
    cwd: input.cwd,
    projectId: input.projectId,
    createdAt: ts,
    updatedAt: ts,
    status,
    model: input.model ?? 'default',
    origin: input.origin,
    kind,
    advisorRole: input.advisorRole,
    parentSessionId: input.parentSessionId,
    contextUsagePct: null,
    orbitSlot,
    worktreePath: input.worktreePath,
    wrapperSocketPath: input.wrapperSocketPath,
    agentViewId: input.agentViewId,
    agentViewSummary: input.agentViewSummary,
    prUrl: input.prUrl,
    prCheckStatus: input.prCheckStatus,
    costUsd: 0,
    planId: input.planId,
    planTaskId: input.planTaskId,
    sessionRole: input.sessionRole,
    gateLevelAtLaunch: input.gateLevelAtLaunch,
    runtime: input.runtime ?? 'claude',
  };
}

/**
 * Sprint L: lightweight setter for Agent View bridge updates. The
 * Agent View watcher polls roster + state.json; when state changes
 * (status, summary, PR fields), it calls this rather than going
 * through upsertSession (which expects a full session record).
 */
export function setAgentViewFields(
  db: DB,
  sessionId: string,
  fields: {
    status?: SessionStatus;
    agentViewSummary?: string | null;
    prUrl?: string | null;
    prCheckStatus?: 'pending' | 'success' | 'failure' | 'neutral' | null;
  },
): Session | null {
  const ts = now();
  const updates: string[] = ['updated_at = ?'];
  const values: unknown[] = [ts];
  if (fields.status !== undefined) {
    updates.push('status = ?');
    values.push(fields.status);
    // `setSessionStatus` writes `terminated_at` alongside the status and
    // this did not, so every Agent View session — reaped or legitimately
    // finished — ended up `terminated` with a NULL `terminated_at`. The
    // timeline builds its window from that column, so no Agent View session
    // ending has ever appeared in it. Only set it once: a second sync must
    // not move the moment it ended.
    if (fields.status === 'terminated') {
      updates.push('terminated_at = COALESCE(terminated_at, ?)');
      values.push(ts);
    }
  }
  if (fields.agentViewSummary !== undefined) {
    updates.push('agent_view_summary = ?');
    values.push(fields.agentViewSummary);
  }
  if (fields.prUrl !== undefined) {
    updates.push('pr_url = ?');
    values.push(fields.prUrl);
  }
  if (fields.prCheckStatus !== undefined) {
    updates.push('pr_check_status = ?');
    values.push(fields.prCheckStatus);
  }
  values.push(sessionId);
  db.prepare(
    `UPDATE sessions SET ${updates.join(', ')} WHERE id = ?`,
  ).run(...values);
  return getSession(db, sessionId);
}

export function setSessionStatus(
  db: DB,
  sessionId: string,
  status: SessionStatus,
): Session | null {
  const ts = now();
  if (status === 'terminated') {
    db.prepare(
      `UPDATE sessions SET status = ?, updated_at = ?, terminated_at = ? WHERE id = ?`,
    ).run(status, ts, ts, sessionId);
  } else {
    db.prepare(
      `UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?`,
    ).run(status, ts, sessionId);
  }
  return getSession(db, sessionId);
}

export function setSessionMission(
  db: DB,
  sessionId: string,
  missionId: string | null,
): Session | null {
  const ts = now();
  db.prepare(
    `UPDATE sessions SET current_mission_id = ?, updated_at = ? WHERE id = ?`,
  ).run(missionId, ts, sessionId);
  return getSession(db, sessionId);
}

/** Sprint J.1: when a wrapper unregisters (claude exited), clear the
 * stored socket path so the SidePanel composer reverts to read-only
 * and `sendPromptToSession` doesn't keep targeting a dead socket. */
export function clearSessionWrapper(
  db: DB,
  sessionId: string,
): Session | null {
  const ts = now();
  db.prepare(
    `UPDATE sessions SET wrapper_socket_path = NULL, updated_at = ? WHERE id = ?`,
  ).run(ts, sessionId);
  return getSession(db, sessionId);
}

export function setSessionContextUsage(
  db: DB,
  sessionId: string,
  pct: number | null,
): Session | null {
  const clamped = pct === null ? null : Math.max(0, Math.min(100, pct));
  const ts = now();
  db.prepare(
    `UPDATE sessions SET context_usage_pct = ?, updated_at = ? WHERE id = ?`,
  ).run(clamped, ts, sessionId);
  return getSession(db, sessionId);
}

/** Sprint M — set the running cost estimate (USD) for a session. */
export function setSessionCost(
  db: DB,
  sessionId: string,
  costUsd: number,
): Session | null {
  const ts = now();
  db.prepare(
    `UPDATE sessions SET cost_usd = ?, updated_at = ? WHERE id = ?`,
  ).run(Math.max(0, costUsd), ts, sessionId);
  return getSession(db, sessionId);
}

/**
 * How far into this session's transcript the cost has already been counted.
 *
 * Kept on the session row rather than in memory, because the whole point is
 * surviving a restart: the watcher used to re-read the replay window on every
 * start and add the same messages to a `cost_usd` that was still in the
 * database, doubling a session's recorded spend each time. Null for a session
 * that predates this column, which reads as 0 and is correct — the one-time
 * reset in `createSolixServer` zeroes those figures anyway.
 */
export function getTranscriptPos(db: DB, sessionId: string): number | null {
  const row = db
    .prepare('SELECT transcript_pos FROM sessions WHERE id = ?')
    .get(sessionId) as { transcript_pos: number | null } | undefined;
  return row?.transcript_pos ?? null;
}

/** Only ever moves forward: a shorter file means a truncation or a rotation,
 *  and re-counting from there would charge twice for the same bytes. */
export function setTranscriptPos(
  db: DB,
  sessionId: string,
  pos: number,
): void {
  db.prepare(
    `UPDATE sessions
        SET transcript_pos = MAX(COALESCE(transcript_pos, 0), ?)
      WHERE id = ?`,
  ).run(Math.max(0, Math.floor(pos)), sessionId);
}

/** Sprint M — set (or raise) the per-session budget cap in USD. */
export function setSessionBudget(
  db: DB,
  sessionId: string,
  budgetUsd: number | null,
): Session | null {
  const ts = now();
  db.prepare(
    `UPDATE sessions SET budget_usd = ?, updated_at = ? WHERE id = ?`,
  ).run(budgetUsd, ts, sessionId);
  return getSession(db, sessionId);
}

/** Sprint M — associate a session with a goal (constellation grouping). */
export function setSessionGoal(
  db: DB,
  sessionId: string,
  goalId: string | null,
): Session | null {
  const ts = now();
  db.prepare(
    `UPDATE sessions SET current_goal_id = ?, updated_at = ? WHERE id = ?`,
  ).run(goalId, ts, sessionId);
  return getSession(db, sessionId);
}

export function getSession(db: DB, sessionId: string): Session | null {
  const row = db
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;
  return row ? rowToSession(row) : null;
}

export function listActiveSessions(db: DB): Session[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE status != 'terminated'
       ORDER BY created_at ASC`,
    )
    .all() as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * How many contained sessions (worker / verifier / routine) are still in
 * flight — not terminated. These are the sessions a governance change would
 * affect mid-run, so the dial refuses to drop below them without `--force`.
 */
export function countInFlightContainedSessions(db: DB): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM sessions
       WHERE status != 'terminated'
         AND session_role IN ('worker', 'verifier', 'routine')`,
    )
    .get() as { c: number } | undefined;
  return row?.c ?? 0;
}

export function listSessionsForProject(db: DB, projectId: string): Session[] {
  const rows = db
    .prepare(
      `SELECT * FROM sessions
       WHERE project_id = ? AND status != 'terminated'
       ORDER BY created_at ASC`,
    )
    .all(projectId) as SessionRow[];
  return rows.map(rowToSession);
}

/**
 * Is a process with this id still running on this machine?
 *
 * `kill(pid, 0)` sends no signal; it only asks. `ESRCH` means no such
 * process. `EPERM` means it exists but belongs to someone else, which is
 * still "running".
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Which program holds a pid, and since when (epoch seconds). */
export interface ProcIdentity {
  startSec: number;
  comm: string;
}

/** `ps` elapsed time `[[dd-]hh:]mm:ss` in seconds. */
function etimeSeconds(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3]) * 60 + Number(m[4]);
}

/**
 * What runs at each pid, from one `ps` call. The same flags work on macOS and
 * Linux. Pids not running are absent from the map.
 */
export function readProcIdentities(pids: readonly number[]): Map<number, ProcIdentity> {
  const out = new Map<number, ProcIdentity>();
  if (pids.length === 0) return out;
  const r = spawnSync('ps', ['-o', 'pid=,etime=,comm=', '-p', pids.join(',')], {
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
  });
  const nowSec = Date.now() / 1000;
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const age = etimeSeconds(m[2]!);
    if (age === null) continue;
    out.set(Number(m[1]), { startSec: nowSec - age, comm: m[3]! });
  }
  return out;
}

/** The program name without its path or a login shell's leading dash. */
export function commName(comm: string): string {
  return comm.split('/').pop()!.replace(/^-/, '');
}

/** A shell is never the agent itself: a hook that reports one reported its parent shell. */
export function isShellComm(comm: string): boolean {
  return /^(sh|bash|zsh|fish|dash|ksh|tcsh|csh)$/.test(commName(comm));
}

/** Seconds of slack when comparing start times read at different moments. */
const START_SLACK_SEC = 3;

/**
 * Retire sessions whose process has ended.
 *
 * Measured on 2026-11-03 on the owner's machine: the top bar read
 * "17 active · 464 idle" among 481 sessions, with only a handful of `claude`
 * processes running. Solix does not install Claude Code's session-end hook,
 * so a session ended only when someone pressed Terminate. A `claude` that
 * exited stayed `idle` forever, and one killed mid-turn stayed `active`.
 *
 * A session is retired when the process it recorded is gone. **Gone includes
 * "its pid now belongs to another program".** Measured on 2026-11-05, after
 * 1.20.4's sweep took the owner's machine from 481 sessions to 8: of those 8,
 * one pid was a running `claude`. Four now belonged to system services, the
 * Dock and another app, because macOS had reused the numbers. Asking only "is
 * something running at this pid?" kept them all. So:
 *
 * - When a session's events arrive, the router records which program holds
 *   its pid and since when (`known`).
 * - At sweep time, a different program, or the same name started at a
 *   different time, means the pid was reused, and the session is retired.
 * - With no record (Solix restarted since the session's last event), a
 *   process that started *after* the session was last heard from cannot be
 *   the agent that sent that event. It is reused too.
 *
 * Deliberately left alone:
 * - Agent View sessions: their supervisor owns their lifecycle.
 * - Sessions still `spawning`: their pid may not be recorded yet.
 * - Sessions in `skip`: the router saw that their pid is not the agent's
 *   process (gone while events still arrived, or a shell), so liveness says
 *   nothing about them.
 * - pid 0/1 (unknown: 1 is init, which a hook reports when its parent had
 *   already exited) and Solix's own pid.
 *
 * Those that cannot be judged still stop counting once they are quiet; see
 * the galaxy's quiet rule.
 *
 * `terminated_at` is the session's last activity, not the moment of the
 * sweep: the process ended at some point after that, and a sweep of a
 * months-old history should not show 400 sessions ending at the same second.
 * A session retired here that turns out to be alive comes back by itself:
 * its next hook event upserts it as `idle`. (`CLAIM-DEAD-SESSIONS-RETIRE`)
 */
export function sweepDeadSessions(
  db: DB,
  opts: {
    isAlive?: (pid: number) => boolean;
    skip?: ReadonlySet<string>;
    /** Session id → the process its events came from, recorded by the router. */
    known?: ReadonlyMap<string, { pid: number } & ProcIdentity>;
    identities?: (pids: readonly number[]) => Map<number, ProcIdentity>;
  } = {},
): string[] {
  const isAlive = opts.isAlive ?? processIsAlive;
  const identities = opts.identities ?? readProcIdentities;
  const rows = db
    .prepare(
      `SELECT id, pid, updated_at FROM sessions
       WHERE status NOT IN ('terminated', 'spawning')
         AND (origin IS NULL OR origin != 'agentview')
         AND pid > 1`,
    )
    .all() as Array<{ id: string; pid: number; updated_at: number }>;
  const retired: string[] = [];
  const retire = db.prepare(
    `UPDATE sessions
     SET status = 'terminated',
         terminated_at = COALESCE(terminated_at, updated_at)
     WHERE id = ? AND status != 'terminated'`,
  );
  const alive: typeof rows = [];
  for (const row of rows) {
    if (opts.skip?.has(row.id)) continue;
    if (row.pid === process.pid) continue;
    if (!isAlive(row.pid)) {
      if (retire.run(row.id).changes > 0) retired.push(row.id);
    } else {
      alive.push(row);
    }
  }
  // Alive at the number is not alive as the agent: check who holds it now.
  const now = identities([...new Set(alive.map((r) => r.pid))]);
  for (const row of alive) {
    const cur = now.get(row.pid);
    if (!cur) continue; // could not read it; say nothing rather than guess
    const rec = opts.known?.get(row.id);
    const reused =
      rec && rec.pid === row.pid
        ? commName(rec.comm) !== commName(cur.comm) || Math.abs(rec.startSec - cur.startSec) > START_SLACK_SEC
        : cur.startSec > row.updated_at / 1000 + START_SLACK_SEC;
    if (reused && retire.run(row.id).changes > 0) retired.push(row.id);
  }
  return retired;
}
