import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { createPlan } from './state/plans.js';

/**
 * The Pro run-gate must be server-authoritative: the generic plan CRUD routes
 * must NOT be a back door to `running` (which would skip evaluateRunGate).
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

describe('plan gate is server-authoritative', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('POST /api/plans refuses to create an already-running plan', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/plans', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: 'x',
        goalPrompt: 'g',
        cwd: '/tmp/p',
        status: 'running',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('PATCH /api/plans/:id cannot flip a plan to running (status stripped)', async () => {
    const plan = createPlan(db, {
      name: 'x',
      goalPrompt: 'g',
      cwd: '/tmp/p',
      status: 'awaiting_approval',
    });
    const app = makeApp(db);
    const res = await app.request(`/api/plans/${plan.id}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: 'running', name: 'renamed' }),
    });
    expect(res.status).toBe(200);
    const after = db
      .prepare('SELECT status, name FROM plans WHERE id = ?')
      .get(plan.id) as { status: string; name: string };
    expect(after.status).toBe('awaiting_approval'); // running was stripped
    expect(after.name).toBe('renamed'); // safe fields still applied
  });

  it('POST /api/plans allows creating an awaiting_approval plan', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/plans', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: 'x',
        goalPrompt: 'g',
        cwd: '/tmp/p',
        status: 'awaiting_approval',
      }),
    });
    expect(res.status).toBe(200);
  });
});
