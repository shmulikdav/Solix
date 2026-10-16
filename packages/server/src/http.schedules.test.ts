import { beforeEach, describe, expect, it } from 'vitest';
import type { ScheduledTask, TriggerKind } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { createSchedule, recordScheduleRun } from './state/schedules.js';

function makeApp(db: DB) {
  const broadcaster = new Broadcaster();
  const router = new EventRouter(db, broadcaster);
  const orchestrator = new Orchestrator({
    db,
    runner: { runOnce: () => Promise.resolve({ ok: true, output: '{}' }) },
    broadcast: () => {},
    getKnownAdvisorRoles: () => [],
    knownModels: ['default'],
    getMaestroPrompt: () => '',
  });
  const fired: Array<{ id: string; trigger: TriggerKind }> = [];
  const app = createHttpApp({
    db,
    router,
    orchestrator,
    fireSchedule: (s: ScheduledTask, trigger: TriggerKind) =>
      fired.push({ id: s.id, trigger }),
  });
  return { app, fired };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('schedule trigger routes (P1 #5)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('creates a webhook routine and fires it via its token', async () => {
    const { app, fired } = makeApp(db);
    const create = await app.request('/api/schedules', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: '/tmp/p', prompt: 'deploy', trigger: 'webhook' }),
    });
    expect(create.status).toBe(200);
    const sched = (await create.json()) as ScheduledTask;
    expect(sched.webhookToken).toBeTruthy();

    const fire = await app.request(`/api/triggers/${sched.webhookToken}`, {
      method: 'POST',
    });
    expect(fire.status).toBe(200);
    expect(fired).toEqual([{ id: sched.id, trigger: 'webhook' }]);
  });

  it('interval create still requires a cadence', async () => {
    const { app } = makeApp(db);
    const res = await app.request('/api/schedules', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: '/tmp/p', prompt: 'p', trigger: 'interval' }),
    });
    expect(res.status).toBe(400);
  });

  it('manual fire route invokes the callback', async () => {
    const { app, fired } = makeApp(db);
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', trigger: 'manual' });
    const res = await app.request(`/api/schedules/${s.id}/fire`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(fired).toEqual([{ id: s.id, trigger: 'manual' }]);
  });

  it('a disabled webhook routine is not fired', async () => {
    const { app, fired } = makeApp(db);
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', trigger: 'webhook' });
    db.prepare('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ?').run(s.id);
    const res = await app.request(`/api/triggers/${s.webhookToken}`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(fired).toHaveLength(0);
  });

  it('unknown token 404s', async () => {
    const { app } = makeApp(db);
    const res = await app.request('/api/triggers/nope', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('exposes run history', async () => {
    const { app } = makeApp(db);
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', cadence: '1h' });
    recordScheduleRun(db, { scheduleId: s.id, trigger: 'interval', status: 'fired' });
    const res = await app.request(`/api/schedules/${s.id}/runs`);
    expect(res.status).toBe(200);
    const runs = (await res.json()) as unknown[];
    expect(runs).toHaveLength(1);
  });
});
