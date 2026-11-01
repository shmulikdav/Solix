import { randomUUID } from 'node:crypto';
import { nanoid } from 'nanoid';
import { cadenceToMs } from '@solix/shared';
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

export function nextRunFrom(fromMs: number, cadence: string): number {
  const ms = cadenceToMs(cadence);
  // Unparseable cadence → park it ~1h out so a typo doesn't busy-fire.
  //
  // This is a backstop for rows that predate validation, not a policy: for
  // a cadence like `1w` it is not a safeguard but a 168x overbill that the
  // card and the cost warning both conceal, because they echo the string
  // the user typed. POST /api/schedules now rejects anything cadenceToMs
  // cannot read, so new routines never reach this branch.
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

/**
 * Change a routine without destroying it.
 *
 * Everything a recreate would have lost stays put: the row's id, so its
 * `schedule_runs` history still points at it, and its `token`, so a webhook
 * already configured somewhere keeps firing. Neither is touched here, and
 * neither is reachable from the route.
 *
 * `next_run_at` is recomputed from **now** when the cadence changes, not from
 * the last run. Recomputing from the last run means shortening `1h` to `10m`
 * fires immediately if the last run was an hour ago — a burst of unplanned
 * spend as the direct result of correcting a typo. A full fresh interval is
 * the predictable reading of "every 10 minutes from now on".
 *
 * A changed `cwd` moves the routine to that directory's project, or its node
 * would keep orbiting the project it no longer runs in.
 */
export function updateSchedule(
  db: DB,
  id: string,
  patch: {
    name?: string | null;
    prompt?: string;
    cadence?: string;
    owner?: string | null;
    cwd?: string;
  },
): ScheduledTask | null {
  const current = getSchedule(db, id);
  if (!current) return null;

  const sets: string[] = [];
  const args: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    sets.push('name = ?');
    args.push(patch.name === null || patch.name === '' ? null : patch.name);
  }
  if (patch.prompt !== undefined) {
    sets.push('prompt = ?');
    args.push(patch.prompt);
  }
  if (patch.owner !== undefined) {
    sets.push('owner = ?');
    args.push(patch.owner === null || patch.owner === '' ? null : patch.owner);
  }
  if (patch.cwd !== undefined && patch.cwd !== current.cwd) {
    const project = ensureProject(db, patch.cwd);
    sets.push('cwd = ?', 'project_id = ?');
    args.push(patch.cwd, project.id);
  }
  if (patch.cadence !== undefined && (current.trigger ?? 'interval') === 'interval') {
    sets.push('cron = ?', 'next_run_at = ?');
    args.push(patch.cadence, nextRunFrom(now(), patch.cadence));
  }

  if (sets.length === 0) return current;
  args.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...args);
  return getSchedule(db, id);
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
