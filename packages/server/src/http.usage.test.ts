import { beforeEach, describe, expect, it } from 'vitest';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { getSession } from './state/sessions.js';
import { listMissions } from './state/missions.js';

/**
 * `POST /api/sessions/:id/usage`.
 *
 * Spend normally arrives from the transcript watcher reading Claude Code's
 * JSONL. `solix demo` has no transcript, so it seeded a cost-governance
 * product with every figure at zero — Mission Control reporting $0.00 spend
 * and $0.00 per mission to the first-time user the README sends there.
 *
 * These pin the accounting the demo now depends on, and the ordering
 * constraint that makes the token half work at all.
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
  return { app: createHttpApp({ db, router, orchestrator }), router };
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** A live session mid-mission, which is when real spend accrues. */
function startSession(router: EventRouter, id = 's1') {
  router.handleHookEvent({
    event: 'session_start',
    pid: 4242,
    cwd: '/tmp/demo-proj',
    ts: Date.now(),
    payload: { session_id: id, model: 'sonnet' },
  });
  router.handleHookEvent({
    event: 'user_prompt_submit',
    pid: 4242,
    cwd: '/tmp/demo-proj',
    ts: Date.now(),
    payload: { session_id: id, prompt: 'ship the thing' },
  });
  return id;
}

describe('session usage route', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('accrues cost rather than overwriting it', async () => {
    const { app, router } = makeApp(db);
    const id = startSession(router);

    for (const costUsd of [0.25, 0.5]) {
      const res = await app.request(`/api/sessions/${id}/usage`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ costUsd }),
      });
      expect(res.status).toBe(200);
    }

    // Two messages cost the sum of both, the way the transcript path adds
    // each assistant message to the running total.
    expect(getSession(db, id)?.costUsd).toBeCloseTo(0.75, 6);
  });

  it('rolls tokens into the mission that is running', async () => {
    const { app, router } = makeApp(db);
    const id = startSession(router);

    await app.request(`/api/sessions/${id}/usage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ costUsd: 0.1, tokens: 12_000 }),
    });

    const [mission] = listMissions(db, { sessionId: id });
    expect(mission?.metrics?.totalTokens).toBe(12_000);
  });

  /**
   * The ordering constraint the demo has to honour. Tokens attach to the
   * session's *current* mission, so usage posted after the stop banks the
   * dollars and silently loses every token — which is exactly how Mission
   * Control ends up showing real spend above a flat 0 tokens.
   */
  it('keeps mission tokens once the mission completes, but not if posted after', async () => {
    const { app, router } = makeApp(db);

    const during = startSession(router, 'during');
    await app.request(`/api/sessions/${during}/usage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ costUsd: 0.1, tokens: 9_000 }),
    });
    router.handleHookEvent({
      event: 'stop',
      pid: 4242,
      cwd: '/tmp/demo-proj',
      ts: Date.now(),
      payload: { session_id: during },
    });

    const after = startSession(router, 'after');
    router.handleHookEvent({
      event: 'stop',
      pid: 4242,
      cwd: '/tmp/demo-proj',
      ts: Date.now(),
      payload: { session_id: after },
    });
    await app.request(`/api/sessions/${after}/usage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ costUsd: 0.1, tokens: 9_000 }),
    });

    expect(listMissions(db, { sessionId: during })[0]?.metrics?.totalTokens).toBe(
      9_000,
    );
    // Dollars still land — only the mission attribution is lost.
    expect(getSession(db, after)?.costUsd).toBeCloseTo(0.1, 6);
    expect(
      listMissions(db, { sessionId: after })[0]?.metrics?.totalTokens ?? 0,
    ).toBe(0);
  });

  it('sets a budget cap and alerts once the spend reaches it', async () => {
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
    const app = createHttpApp({ db, router, orchestrator });
    const id = startSession(router);

    const seen: ServerMessage[] = [];
    broadcaster.tap((msg) => seen.push(msg));

    await app.request(`/api/sessions/${id}/usage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ budgetUsd: 1 }),
    });
    expect(getSession(db, id)?.budgetUsd).toBe(1);

    // Under the cap: spend is reported, no alarm.
    await app.request(`/api/sessions/${id}/usage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ costUsd: 0.4 }),
    });
    expect(seen.map((m) => m.type)).toContain('cost_update');
    expect(seen.map((m) => m.type)).not.toContain('budget_alert');

    // Over it: the ring has to be told, which is the whole point of a cap.
    await app.request(`/api/sessions/${id}/usage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ costUsd: 0.85 }),
    });
    expect(getSession(db, id)?.costUsd).toBeCloseTo(1.25, 6);
    const alert = seen.find((m) => m.type === 'budget_alert');
    expect(alert).toMatchObject({ costUsd: 1.25, budgetUsd: 1 });
  });

  it('rejects a body with nothing to apply, and non-numbers', async () => {
    const { app, router } = makeApp(db);
    const id = startSession(router);

    const empty = await app.request(`/api/sessions/${id}/usage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(empty.status).toBe(400);

    const bad = await app.request(`/api/sessions/${id}/usage`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ costUsd: 'free' }),
    });
    expect(bad.status).toBe(400);

    // A cost that is not a number must not land as NaN in the ledger.
    expect(getSession(db, id)?.costUsd).toBe(0);
  });

  it('404s for a session that does not exist', async () => {
    const { app } = makeApp(db);
    const res = await app.request('/api/sessions/nope/usage', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ costUsd: 1 }),
    });
    expect(res.status).toBe(404);
  });
});
