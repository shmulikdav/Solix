import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { ScheduledTask, ScheduleRun, TriggerKind } from '@solix/shared';
import type { DB } from '../db.js';
import { ensureProject } from './projects.js';
import { now } from '../util.js';

interface ScheduleRow {
  id: string;
  project_id: string;
  cwd: string | null;
  name: string | null;
  prompt: string;
  cron: string;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number;
  trigger: string | null;
  owner: string | null;
  token: string | null;
}

function rowToSchedule(row: ScheduleRow): ScheduledTask {
  const trigger = (row.trigger as TriggerKind | null) ?? 'interval';
  return {
    id: row.id,
    projectId: row.project_id,
    cwd: row.cwd ?? '',
    name: row.name ?? undefined,
    prompt: row.prompt,
    cron: row.cron,
    enabled: row.enabled !== 0,
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at,
    trigger,
    owner: row.owner ?? undefined,
    // Only webhook triggers carry a usable token; never surface a stray one.
    webhookToken: trigger === 'webhook' ? row.token ?? undefined : undefined,
  };
}

/**
 * Parse a simple cadence string into milliseconds. Sprint M supports
 * `<n>m` (minutes), `<n>h` (hours), `<n>d` (days). Full cron is future
 * work. Returns null for unparseable input.
 */
export function cadenceToMs(cadence: string): number | null {
  const m = cadence.trim().match(/^(\d+)\s*([mhd])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2]!.toLowerCase();
  const mult = unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return n * mult;
}

export function nextRunFrom(fromMs: number, cadence: string): number {
  const ms = cadenceToMs(cadence);
  // Unparseable cadence → park it ~1h out so a typo doesn't busy-fire.
  return fromMs + (ms ?? 3_600_000);
}

// Non-interval triggers never fire on the heartbeat timer. Park next_run_at far
// in the future so they're excluded from the due query even on legacy rows.
const NEVER = 8.64e15; // ~ max JS Date

export function createSchedule(
  db: DB,
  input: {
    cwd: string;
    prompt: string;
    cadence?: string;
    name?: string;
    trigger?: TriggerKind;
    owner?: string;
  },
): ScheduledTask {
  const project = ensureProject(db, input.cwd);
  const id = nanoid(8);
  const ts = now();
  const trigger: TriggerKind = input.trigger ?? 'interval';
  const cadence = input.cadence ?? (trigger === 'interval' ? '1h' : trigger);
  const nextRun = trigger === 'interval' ? nextRunFrom(ts, cadence) : NEVER;
  const token = trigger === 'webhook' ? nanoid(32) : null;
  db.prepare(
    `INSERT INTO scheduled_tasks
       (id, project_id, cwd, name, prompt, cron, enabled, last_run_at, next_run_at,
        trigger, owner, token)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?)`,
  ).run(
    id,
    project.id,
    input.cwd,
    input.name ?? null,
    input.prompt,
    cadence,
    nextRun,
    trigger,
    input.owner ?? null,
    token,
  );
  return getSchedule(db, id)!;
}

export function getSchedule(db: DB, id: string): ScheduledTask | null {
  const row = db
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduleRow | undefined;
  return row ? rowToSchedule(row) : null;
}

/** Resolve a webhook trigger by its capability token (constant-ish lookup). */
export function getScheduleByToken(db: DB, token: string): ScheduledTask | null {
  if (!token) return null;
  const row = db
    .prepare(`SELECT * FROM scheduled_tasks WHERE token = ? AND trigger = 'webhook'`)
    .get(token) as ScheduleRow | undefined;
  return row ? rowToSchedule(row) : null;
}

export function listSchedules(db: DB): ScheduledTask[] {
  const rows = db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY next_run_at ASC')
    .all() as ScheduleRow[];
  return rows.map(rowToSchedule);
}

/** Schedules whose next run is due — interval triggers only (webhook/manual
 *  never fire on the timer). */
export function listDueSchedules(db: DB, asOf: number): ScheduledTask[] {
  const rows = db
    .prepare(
      `SELECT * FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at <= ?
          AND (trigger = 'interval' OR trigger IS NULL)`,
    )
    .all(asOf) as ScheduleRow[];
  return rows.map(rowToSchedule);
}

export function setScheduleEnabled(
  db: DB,
  id: string,
  enabled: boolean,
): ScheduledTask | null {
  db.prepare('UPDATE scheduled_tasks SET enabled = ? WHERE id = ?').run(
    enabled ? 1 : 0,
    id,
  );
  return getSchedule(db, id);
}

/** Record a fire: set last_run_at = now and advance next_run_at (interval only). */
export function markScheduleRun(db: DB, id: string): ScheduledTask | null {
  const sched = getSchedule(db, id);
  if (!sched) return null;
  const ts = now();
  const next =
    sched.trigger === 'interval' ? nextRunFrom(ts, sched.cron) : NEVER;
  db.prepare(
    'UPDATE scheduled_tasks SET last_run_at = ?, next_run_at = ? WHERE id = ?',
  ).run(ts, next, id);
  return getSchedule(db, id);
}

export function deleteSchedule(db: DB, id: string): boolean {
  db.prepare('DELETE FROM schedule_runs WHERE schedule_id = ?').run(id);
  const res = db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
  return res.changes > 0;
}

// ── Run history (P1 #5) ────────────────────────────────────────────────

export function recordScheduleRun(
  db: DB,
  input: {
    scheduleId: string;
    trigger: TriggerKind | string;
    status: ScheduleRun['status'];
    detail?: string;
  },
): ScheduleRun {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO schedule_runs (id, schedule_id, trigger, status, detail, fired_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.scheduleId, input.trigger, input.status, input.detail ?? null, ts);
  return {
    id,
    scheduleId: input.scheduleId,
    trigger: input.trigger,
    status: input.status,
    detail: input.detail,
    firedAt: ts,
  };
}

/** A routine's recent runs, newest first (capped). */
export function listScheduleRuns(
  db: DB,
  scheduleId: string,
  limit = 50,
): ScheduleRun[] {
  const rows = db
    .prepare(
      `SELECT * FROM schedule_runs WHERE schedule_id = ?
        ORDER BY fired_at DESC, rowid DESC LIMIT ?`,
    )
    .all(scheduleId, limit) as Array<{
    id: string;
    schedule_id: string;
    trigger: string;
    status: string;
    detail: string | null;
    fired_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    scheduleId: r.schedule_id,
    trigger: r.trigger,
    status: r.status,
    detail: r.detail ?? undefined,
    firedAt: r.fired_at,
  }));
}
