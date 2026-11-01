import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import {
  createSchedule,
  getSchedule,
  getScheduleByToken,
  listScheduleRuns,
  recordScheduleRun,
  setScheduleEnabled,
} from './state/schedules.js';
import type { ScheduledTask } from '@solix/shared';

/**
 * `PATCH /api/schedules/:id`, which did not exist.
 *
 * The Routines tab has carried this since it shipped: "there is no edit: the
 * server has no PATCH for a routine, and recreating one would drop its run
 * history and rotate its webhook token, silently breaking any webhook already
 * pointed at it." A mistyped cadence was therefore unfixable — on the surface
 * whose entire purpose is making recurring spend controllable, and right after
 * a release note explaining that an unreadable cadence could bill 168× what
 * the card said.
 *
 * The route's job is to be safe to point a button at: strip what a client
 * should not be able to set, refuse what cannot be done with a sentence worth
 * reading, and leave the id and the token alone.
 */
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
  return createHttpApp({ db, router, orchestrator });
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('CLAIM-ROUTINE-EDIT-KEEPS-HISTORY · PATCH /api/schedules/:id', () => {
  let db: DB;
  let app: ReturnType<typeof makeApp>;

  const patch = (id: string, body: unknown) =>
    app.request(`/api/schedules/${id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

  beforeEach(() => {
    db = resetDbForTests();
    app = makeApp(db);
  });

  function interval(over: Partial<Parameters<typeof createSchedule>[1]> = {}): ScheduledTask {
    return createSchedule(db, {
      cwd: '/tmp/alpha',
      prompt: 'sweep the logs',
      cadence: '1h',
      ...over,
    });
  }

  it('corrects a cadence, which was the whole reason this was unfixable', async () => {
    const s = interval();
    const res = await patch(s.id, { cadence: '30m' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ScheduledTask).cron).toBe('30m');
  });

  it('keeps the run history and the webhook token across an edit', async () => {
    const s = createSchedule(db, {
      cwd: '/tmp/alpha',
      prompt: 'deploy',
      trigger: 'webhook',
    });
    const token = s.webhookToken!;
    recordScheduleRun(db, { scheduleId: s.id, trigger: 'webhook', status: 'ok' });

    const res = await patch(s.id, { prompt: 'deploy v2', name: 'ship it' });

    expect(res.status).toBe(200);
    const updated = (await res.json()) as ScheduledTask;
    expect(updated.id).toBe(s.id);
    expect(updated.webhookToken).toBe(token);
    expect(listScheduleRuns(db, s.id)).toHaveLength(1);
    // And the URL someone already configured still resolves to it.
    expect(getScheduleByToken(db, token)?.prompt).toBe('deploy v2');
  });

  it('refuses a cadence it cannot read, with the sentence that names the fix', async () => {
    const s = interval();
    const res = await patch(s.id, { cadence: '1w' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/use 7d/);
    expect(getSchedule(db, s.id)?.cron).toBe('1h');
  });

  it('refuses to change the trigger', async () => {
    const s = interval();
    const res = await patch(s.id, { trigger: 'webhook' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /trigger cannot be changed/,
    );
    expect(getSchedule(db, s.id)?.trigger).toBe('interval');
    expect(getSchedule(db, s.id)?.webhookToken).toBeUndefined();
  });

  it('refuses a cadence on a routine that does not fire on one', async () => {
    const s = createSchedule(db, {
      cwd: '/tmp/alpha',
      prompt: 'deploy',
      trigger: 'webhook',
    });
    const res = await patch(s.id, { cadence: '5m' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/webhook/);
  });

  it('cannot enable or disable a routine', async () => {
    // The toggle owns that. A generic PATCH must not start a routine spending
    // money behind it — the rule the plan PATCH has followed since 1.17.
    const s = interval();
    setScheduleEnabled(db, s.id, false);

    const res = await patch(s.id, { enabled: true, prompt: 'x' });

    expect(res.status).toBe(200);
    expect(getSchedule(db, s.id)?.enabled).toBe(false);
    expect(getSchedule(db, s.id)?.prompt).toBe('x');
  });

  it('cannot rotate or set the webhook token', async () => {
    const s = createSchedule(db, {
      cwd: '/tmp/alpha',
      prompt: 'deploy',
      trigger: 'webhook',
    });
    const token = s.webhookToken!;

    const res = await patch(s.id, { webhookToken: 'chosen-by-the-caller' });

    expect(res.status).toBe(200);
    expect(getSchedule(db, s.id)?.webhookToken).toBe(token);
    expect(getScheduleByToken(db, 'chosen-by-the-caller')).toBeNull();
  });

  it('cannot move a routine to another id or project directly', async () => {
    const s = interval();
    const res = await patch(s.id, { id: 'hijacked', projectId: 'other' });
    expect(res.status).toBe(200);
    expect(getSchedule(db, 'hijacked')).toBeNull();
    expect(getSchedule(db, s.id)?.projectId).toBe(s.projectId);
  });

  it('accepts the routine echoed back unchanged', async () => {
    // A panel that sends the whole object is the obvious thing to write.
    const s = interval({ name: 'nightly', owner: 'argus' });
    const res = await patch(s.id, s);
    expect(res.status).toBe(200);
    const after = (await res.json()) as ScheduledTask;
    expect(after.cron).toBe('1h');
    expect(after.name).toBe('nightly');
    expect(after.trigger).toBe('interval');
  });

  it('expands ~ in a new directory, as the create route does', async () => {
    const s = interval();
    const res = await patch(s.id, { cwd: '~/projects/beta' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as ScheduledTask).cwd).not.toContain('~');
  });

  it('404s for a routine that does not exist', async () => {
    const res = await patch('nope', { prompt: 'x' });
    expect(res.status).toBe(404);
  });

  it('broadcasts the change so the galaxy updates without a reload', async () => {
    const s = interval();
    const seen: unknown[] = [];
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
    const app2 = createHttpApp({ db, router, orchestrator });
    broadcaster.add({
      send: (m: string) => seen.push(JSON.parse(m)),
      close: () => {},
    } as never);

    await app2.request(`/api/schedules/${s.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ cadence: '45m' }),
    });

    expect(
      seen.some(
        (m) =>
          (m as { type?: string }).type === 'schedule_upsert' &&
          ((m as { schedule?: ScheduledTask }).schedule?.cron === '45m'),
      ),
      `no schedule_upsert carrying the new cadence: ${JSON.stringify(seen)}`,
    ).toBe(true);
  });
});
