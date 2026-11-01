import { describe, it, expect, beforeEach } from 'vitest';
import { resetDbForTests, type DB } from '../db.js';
import {
  createSchedule,
  deleteSchedule,
  getScheduleByToken,
  listDueSchedules,
  listScheduleRuns,
  markScheduleRun,
  recordScheduleRun,
  updateSchedule,
} from './schedules.js';

describe('schedules — triggers (P1 #5)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('defaults to an interval trigger with a cadence', () => {
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', cadence: '30m' });
    expect(s.trigger).toBe('interval');
    expect(s.cron).toBe('30m');
    expect(s.webhookToken).toBeUndefined();
    expect(s.nextRunAt).toBeGreaterThan(Date.now());
  });

  it('mints a capability token for a webhook trigger and resolves it', () => {
    const s = createSchedule(db, {
      cwd: '/tmp/p',
      prompt: 'deploy',
      trigger: 'webhook',
      owner: 'ops',
    });
    expect(s.trigger).toBe('webhook');
    expect(s.owner).toBe('ops');
    expect(s.webhookToken).toBeTruthy();
    const resolved = getScheduleByToken(db, s.webhookToken!);
    expect(resolved?.id).toBe(s.id);
    // Unknown token resolves to nothing.
    expect(getScheduleByToken(db, 'nope')).toBeNull();
  });

  it('a manual trigger has no token and is not resolvable by token', () => {
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', trigger: 'manual' });
    expect(s.trigger).toBe('manual');
    expect(s.webhookToken).toBeUndefined();
  });

  it('listDueSchedules returns only due interval triggers', () => {
    const interval = createSchedule(db, { cwd: '/tmp/p', prompt: 'a', cadence: '30m' });
    const webhook = createSchedule(db, { cwd: '/tmp/p', prompt: 'b', trigger: 'webhook' });
    const manual = createSchedule(db, { cwd: '/tmp/p', prompt: 'c', trigger: 'manual' });
    // Force the interval one due.
    db.prepare('UPDATE scheduled_tasks SET next_run_at = 1 WHERE id = ?').run(interval.id);
    const due = listDueSchedules(db, Date.now());
    const ids = due.map((d) => d.id);
    expect(ids).toContain(interval.id);
    expect(ids).not.toContain(webhook.id);
    expect(ids).not.toContain(manual.id);
  });

  it('markScheduleRun advances an interval but leaves a webhook parked', () => {
    const interval = createSchedule(db, { cwd: '/tmp/p', prompt: 'a', cadence: '30m' });
    const webhook = createSchedule(db, { cwd: '/tmp/p', prompt: 'b', trigger: 'webhook' });
    const beforeNext = webhook.nextRunAt;
    const i = markScheduleRun(db, interval.id)!;
    const w = markScheduleRun(db, webhook.id)!;
    expect(i.lastRunAt).toBeTruthy();
    expect(i.nextRunAt).toBeGreaterThan(Date.now());
    expect(w.lastRunAt).toBeTruthy();
    expect(w.nextRunAt).toBe(beforeNext); // still parked far out
  });

  it('records and lists run history newest-first, and cascades on delete', () => {
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', cadence: '1h' });
    recordScheduleRun(db, { scheduleId: s.id, trigger: 'interval', status: 'fired', detail: 'one' });
    recordScheduleRun(db, { scheduleId: s.id, trigger: 'manual', status: 'fired', detail: 'two' });
    const runs = listScheduleRuns(db, s.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]!.detail).toBe('two'); // newest first
    expect(runs[1]!.trigger).toBe('interval');

    deleteSchedule(db, s.id);
    expect(listScheduleRuns(db, s.id)).toHaveLength(0);
  });
});

/**
 * Editing a routine, which was not possible at all.
 *
 * The Routines tab named the cost of not having this: "recreating one would
 * drop its run history and rotate its webhook token, silently breaking any
 * webhook already pointed at it." So the tests that matter most here are the
 * two about what does *not* change.
 */
describe('CLAIM-ROUTINE-EDIT-KEEPS-HISTORY · updateSchedule', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('keeps the run history, because it keeps the row', () => {
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'old', cadence: '1h' });
    recordScheduleRun(db, { scheduleId: s.id, trigger: 'interval', status: 'ok' });
    recordScheduleRun(db, { scheduleId: s.id, trigger: 'manual', status: 'error' });
    expect(listScheduleRuns(db, s.id)).toHaveLength(2);

    const updated = updateSchedule(db, s.id, { prompt: 'new', cadence: '15m' })!;

    expect(updated.id).toBe(s.id);
    expect(updated.prompt).toBe('new');
    expect(updated.cron).toBe('15m');
    expect(listScheduleRuns(db, s.id)).toHaveLength(2);
  });

  it('keeps the webhook token, so a URL already pointed at it still fires', () => {
    const s = createSchedule(db, {
      cwd: '/tmp/p',
      prompt: 'deploy',
      trigger: 'webhook',
    });
    const token = s.webhookToken!;

    const updated = updateSchedule(db, s.id, { prompt: 'deploy v2', name: 'ship' })!;

    expect(updated.webhookToken).toBe(token);
    expect(getScheduleByToken(db, token)?.prompt).toBe('deploy v2');
  });

  it('recomputes the next run from now, not from the last one', () => {
    // Shortening 1h to 10m when the last run was an hour ago fires immediately
    // if the new interval is measured from that run — a burst of unplanned
    // spend caused by correcting a typo.
    //
    // The last run has to be genuinely in the past for the two formulas to
    // differ. The first version of this test called markScheduleRun(), which
    // sets last_run_at to *now*, so it passed either way and proved nothing.
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', cadence: '1h' });
    const anHourAgo = Date.now() - 3_600_000;
    db.prepare('UPDATE scheduled_tasks SET last_run_at = ? WHERE id = ?').run(
      anHourAgo,
      s.id,
    );

    const before = Date.now();
    const updated = updateSchedule(db, s.id, { cadence: '10m' })!;

    expect(updated.lastRunAt).toBe(anHourAgo); // the premise still holds
    expect(updated.nextRunAt).toBeGreaterThanOrEqual(before + 9 * 60_000);
    expect(updated.nextRunAt).toBeLessThanOrEqual(Date.now() + 11 * 60_000);
    // And nothing is due right now, which is the user-visible consequence.
    expect(listDueSchedules(db, Date.now())).toEqual([]);
  });

  it('moves the routine to the project of its new directory', () => {
    // Otherwise its node keeps orbiting a project it no longer runs in.
    const s = createSchedule(db, { cwd: '/tmp/alpha', prompt: 'p', cadence: '1h' });
    const updated = updateSchedule(db, s.id, { cwd: '/tmp/beta' })!;
    expect(updated.cwd).toBe('/tmp/beta');
    expect(updated.projectId).not.toBe(s.projectId);
  });

  it('leaves a non-interval routine parked when a cadence slips through', () => {
    // The route refuses this; the state function must not corrupt the row if
    // it is ever called directly — a webhook routine with a real next_run_at
    // would start firing on the heartbeat as well as its URL.
    const s = createSchedule(db, {
      cwd: '/tmp/p',
      prompt: 'deploy',
      trigger: 'webhook',
    });
    const updated = updateSchedule(db, s.id, { cadence: '1m' })!;
    expect(updated.cron).toBe(s.cron);
    expect(listDueSchedules(db, Date.now() + 86_400_000)).toEqual([]);
  });

  it('clears a name or owner when given an empty value, and keeps the rest', () => {
    const s = createSchedule(db, {
      cwd: '/tmp/p',
      prompt: 'p',
      cadence: '1h',
      name: 'nightly',
      owner: 'argus',
    });
    const updated = updateSchedule(db, s.id, { name: '', owner: null })!;
    expect(updated.name).toBeUndefined();
    expect(updated.owner).toBeUndefined();
    expect(updated.prompt).toBe('p');
    expect(updated.cron).toBe('1h');
  });

  it('is a no-op for an empty patch, and null for a routine that is gone', () => {
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', cadence: '1h' });
    expect(updateSchedule(db, s.id, {})).toEqual(s);
    deleteSchedule(db, s.id);
    expect(updateSchedule(db, s.id, { prompt: 'x' })).toBeNull();
  });

  it('does not disable or enable a routine', () => {
    // `enabled` has its own route. This function has no way to reach it, which
    // is the point — the field is stripped before it ever gets here.
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', cadence: '1h' });
    const updated = updateSchedule(db, s.id, {
      prompt: 'x',
      // Spelled this way because the parameter type has no `enabled`: there is
      // no field to set, which is the assertion.
      ...(JSON.parse('{"enabled":false}') as Record<string, never>),
    })!;
    expect(updated.enabled).toBe(true);
  });
});
