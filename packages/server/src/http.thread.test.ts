import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskThreadEntry } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { createPlan, createPlanTask } from './state/plans.js';

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

function seedTask(db: DB) {
  const plan = createPlan(db, { name: 'P', goalPrompt: 'g', cwd: '/tmp/p' });
  const task = createPlanTask(db, { planId: plan.id, title: 'T', prompt: 'p' });
  return { plan, task };
}

describe('task thread routes', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('POST appends a human comment and GET lists it', async () => {
    const { plan, task } = seedTask(db);
    const app = makeApp(db);
    const post = await app.request(
      `/api/plans/${plan.id}/tasks/${task.id}/thread`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ body: 'tighten the copy' }) },
    );
    expect(post.status).toBe(200);
    const entry = (await post.json()) as TaskThreadEntry;
    expect(entry.kind).toBe('comment');
    expect(entry.author).toBe('human');
    expect(entry.body).toBe('tighten the copy');

    const get = await app.request(`/api/plans/${plan.id}/tasks/${task.id}/thread`);
    expect(get.status).toBe(200);
    const list = (await get.json()) as TaskThreadEntry[];
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(entry.id);
  });

  it('POST rejects an empty body', async () => {
    const { plan, task } = seedTask(db);
    const app = makeApp(db);
    const res = await app.request(
      `/api/plans/${plan.id}/tasks/${task.id}/thread`,
      { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ body: '   ' }) },
    );
    expect(res.status).toBe(400);
  });

  it('404s for an unknown task', async () => {
    const { plan } = seedTask(db);
    const app = makeApp(db);
    const get = await app.request(`/api/plans/${plan.id}/tasks/nope/thread`);
    expect(get.status).toBe(404);
    const post = await app.request(`/api/plans/${plan.id}/tasks/nope/thread`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ body: 'x' }),
    });
    expect(post.status).toBe(404);
  });
});
