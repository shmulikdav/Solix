import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { ensureProject } from './state/projects.js';
import { setSessionCost, setSessionStatus, upsertSession } from './state/sessions.js';

/**
 * CLAIM-GALAXY-HIDES-QUIET, in the band: the line above the Claude Code prompt
 * ("solix 3 active · 4 idle · $1.25") counts the fleet right now, by the same
 * rule as the galaxy and the top bar. An idle session quiet for over a day is
 * not counted. Its spend still is, because money spent is spent.
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

function seed(db: DB, id: string, status: 'idle' | 'active', updatedAt: number, cost = 0): void {
  const project = ensureProject(db, '/tmp/band');
  upsertSession(db, { id, pid: 0, projectId: project.id, cwd: '/tmp/band', origin: 'external' });
  setSessionStatus(db, id, status);
  if (cost) setSessionCost(db, id, cost);
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(updatedAt, id);
}

describe('CLAIM-GALAXY-HIDES-QUIET · the band counts what is live', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('leaves quiet idle sessions out of the idle count, but not out of the spend', async () => {
    const old = Date.now() - 3 * 24 * 3600_000;
    seed(db, 'quiet-1', 'idle', old, 1);
    seed(db, 'quiet-2', 'idle', old);
    seed(db, 'recent', 'idle', Date.now() - 60_000);
    seed(db, 'old-active', 'active', old);

    const res = await makeApp(db).request('/api/band', { headers: { host: '127.0.0.1:4242' } });
    const body = (await res.json()) as { active: number; idle: number; spendUsd: number };
    expect(body).toMatchObject({ active: 1, idle: 1 });
    expect(body.spendUsd).toBeGreaterThan(0);
  });
});
