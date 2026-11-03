import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { ensureProject } from './state/projects.js';
import { upsertSession } from './state/sessions.js';
import {
  getGovernanceLevel,
  governanceRank,
  isGovernanceDowngrade,
  setGovernanceLevel,
} from './state/governance.js';

/**
 * CLAIM-DOWNGRADE-NEEDS-FORCE. Lowering the dial holds less for a person;
 * doing it while contained sessions are already running changes the rules
 * they are held to in the middle of their work. The edge refuses unless the
 * caller says so.
 */
describe('governance ranking', () => {
  it('orders observe < standard < strict', () => {
    expect(governanceRank('observe')).toBeLessThan(governanceRank('standard'));
    expect(governanceRank('standard')).toBeLessThan(governanceRank('strict'));
  });
  it('calls only a move to a lower rank a downgrade', () => {
    expect(isGovernanceDowngrade('strict', 'standard')).toBe(true);
    expect(isGovernanceDowngrade('standard', 'observe')).toBe(true);
    expect(isGovernanceDowngrade('observe', 'standard')).toBe(false);
    expect(isGovernanceDowngrade('standard', 'standard')).toBe(false);
  });
});

describe('POST /api/system/governance', () => {
  let db: DB;
  let app: ReturnType<typeof createHttpApp>;

  beforeEach(() => {
    db = resetDbForTests();
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
    app = createHttpApp({ db, router, orchestrator });
    setGovernanceLevel(db, 'standard');
  });

  function runningWorker() {
    const project = ensureProject(db, '/tmp/gov');
    upsertSession(db, {
      id: 'w1',
      pid: 1,
      projectId: project.id,
      cwd: '/tmp/gov',
      origin: 'internal',
      sessionRole: 'worker',
    });
  }

  function post(body: unknown) {
    return app.request('/api/system/governance', {
      method: 'POST',
      headers: { host: '127.0.0.1:4242', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('refuses an unforced downgrade while a contained session is in flight', async () => {
    runningWorker();
    const res = await post({ level: 'observe' });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { inFlight: number; needsForce: boolean };
    expect(json.needsForce).toBe(true);
    expect(json.inFlight).toBe(1);
    // Nothing changed.
    expect(getGovernanceLevel(db)).toBe('standard');
  });

  it('allows the same downgrade with force', async () => {
    runningWorker();
    const res = await post({ level: 'observe', force: true });
    expect(res.status).toBe(200);
    expect(getGovernanceLevel(db)).toBe('observe');
  });

  it('allows a downgrade when nothing contained is running', async () => {
    const res = await post({ level: 'observe' });
    expect(res.status).toBe(200);
    expect(getGovernanceLevel(db)).toBe('observe');
  });

  it('never blocks an upgrade', async () => {
    runningWorker();
    const res = await post({ level: 'strict' });
    expect(res.status).toBe(200);
    expect(getGovernanceLevel(db)).toBe('strict');
  });

  it('ignores a terminated worker — it is not in flight', async () => {
    const project = ensureProject(db, '/tmp/gov');
    upsertSession(db, {
      id: 'dead',
      pid: 1,
      projectId: project.id,
      cwd: '/tmp/gov',
      origin: 'internal',
      sessionRole: 'worker',
    });
    db.prepare("UPDATE sessions SET status = 'terminated' WHERE id = 'dead'").run();
    const res = await post({ level: 'observe' });
    expect(res.status).toBe(200);
  });
});
