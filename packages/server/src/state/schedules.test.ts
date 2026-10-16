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
