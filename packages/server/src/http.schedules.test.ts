import { beforeEach, describe, expect, it } from 'vitest';
import type { ScheduledTask, TriggerKind } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import {
  createSchedule,
  recordScheduleRun,
  setScheduleEnabled,
} from './state/schedules.js';

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
    fireSchedule: (s: ScheduledTask, trigger: TriggerKind) => {
      fired.push({ id: s.id, trigger });
      return { ok: true as const };
    },
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

/**
 * CLAIM-DISABLED-MEANS-DISABLED.
 *
 * `POST /api/schedules/:id/fire` had no `enabled` check, while the webhook
 * route six lines below returned `409 "routine is disabled"` for exactly
 * that. Two routes giving opposite answers about the same state means
 * "disabled" was not a guarantee of anything: `solix schedules disable X`
 * printed "disabled", and `fire X` ran it and printed success. The UI's
 * **Run now** was rendered on a disabled card too, so turning a routine off
 * and then clicking the obvious button spent money.
 *
 * And `fireScheduleNow` returned `void`, swallowing "no working directory"
 * (recorded as `skipped`) and a launcher throw (recorded as `error`) into
 * the run history and nowhere else — so the route answered `{ok:true}` over
 * a launch that never happened. That is `solix demo`'s "seed complete"
 * defect on a different command.
 */
describe('CLAIM-DISABLED-MEANS-DISABLED', () => {
  let db: DB;

  function appWith(
    fire: (
      s: ScheduledTask,
      t: TriggerKind,
    ) => { ok: true } | { ok: false; error: string },
  ) {
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
    return createHttpApp({ db, router, orchestrator, fireSchedule: fire });
  }

  beforeEach(() => {
    db = resetDbForTests();
  });

  it('refuses to fire a routine that is switched off', async () => {
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', cadence: '1h' });
    setScheduleEnabled(db, s.id, false);
    let fired = 0;
    const app = appWith(() => {
      fired += 1;
      return { ok: true };
    });

    const res = await app.request(`/api/schedules/${s.id}/fire`, { method: 'POST' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/disabled/);
    expect(fired, 'it must not have run').toBe(0);
  });

  it('gives the same answer the webhook route always gave', async () => {
    // The two routes disagreeing about one piece of state was the defect.
    const s = createSchedule(db, {
      cwd: '/tmp/p',
      prompt: 'p',
      trigger: 'webhook',
    });
    setScheduleEnabled(db, s.id, false);
    const app = appWith(() => ({ ok: true }));

    const viaFire = await app.request(`/api/schedules/${s.id}/fire`, { method: 'POST' });
    const viaHook = await app.request(`/api/triggers/${s.webhookToken}`, {
      method: 'POST',
    });

    expect(viaFire.status).toBe(409);
    expect(viaHook.status).toBe(409);
  });

  it('still fires an enabled routine', async () => {
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', cadence: '1h' });
    let fired = 0;
    const app = appWith(() => {
      fired += 1;
      return { ok: true };
    });

    const res = await app.request(`/api/schedules/${s.id}/fire`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(fired).toBe(1);
  });

  it('reports a launch that did not happen instead of answering ok', async () => {
    const s = createSchedule(db, { cwd: '/tmp/p', prompt: 'p', cadence: '1h' });
    const app = appWith(() => ({ ok: false, error: 'no working directory set' }));

    const res = await app.request(`/api/schedules/${s.id}/fire`, { method: 'POST' });

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /no working directory/,
    );
  });

  it('reports a failed webhook launch too', async () => {
    const s = createSchedule(db, {
      cwd: '/tmp/p',
      prompt: 'p',
      trigger: 'webhook',
    });
    const app = appWith(() => ({ ok: false, error: 'spawn ENOENT' }));

    const res = await app.request(`/api/triggers/${s.webhookToken}`, {
      method: 'POST',
    });

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/ENOENT/);
  });
});
