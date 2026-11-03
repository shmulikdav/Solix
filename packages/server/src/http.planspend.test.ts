import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { ensureProject } from './state/projects.js';
import { createPlan } from './state/plans.js';
import { setSessionCost, upsertSession } from './state/sessions.js';

/**
 * A plan card could show a budget cap with no way to see how much of it had
 * been spent — the one number a person watching a running plan most wants.
 * `GET /api/plans/:id` now returns `spendUsd` beside the plan, summed over the
 * plan's sessions (the same figure the budget gate pauses on).
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

const HDR = { host: '127.0.0.1:4242' };

describe('GET /api/plans/:id spendUsd', () => {
  let db: DB;
  let app: ReturnType<typeof createHttpApp>;
  beforeEach(() => {
    db = resetDbForTests();
    app = makeApp(db);
  });

  it('is zero for a plan that has spent nothing', async () => {
    const plan = createPlan(db, { name: 'p', goalPrompt: 'g', cwd: '/tmp/ps', status: 'running' });
    const res = await app.request(`/api/plans/${plan.id}`, { headers: HDR });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spendUsd: number };
    expect(body.spendUsd).toBe(0);
  });

  it('sums cost over the plan sessions', async () => {
    const project = ensureProject(db, '/tmp/ps');
    const plan = createPlan(db, { name: 'p', goalPrompt: 'g', cwd: '/tmp/ps', status: 'running' });
    for (const [id, cost] of [['w1', 1.25], ['w2', 0.75]] as const) {
      upsertSession(db, { id, pid: 1, projectId: project.id, cwd: '/tmp/ps', origin: 'internal', sessionRole: 'worker', planId: plan.id });
      setSessionCost(db, id, cost);
    }
    // A session from another plan is not counted.
    upsertSession(db, { id: 'other', pid: 1, projectId: project.id, cwd: '/tmp/ps', origin: 'internal', sessionRole: 'worker', planId: 'plan-other' });
    setSessionCost(db, 'other', 99);

    const res = await app.request(`/api/plans/${plan.id}`, { headers: HDR });
    const body = (await res.json()) as { spendUsd: number; plan: { id: string } };
    expect(body.spendUsd).toBeCloseTo(2.0, 5);
    expect(body.plan.id).toBe(plan.id);
  });
});
