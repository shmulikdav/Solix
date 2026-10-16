import { beforeEach, describe, expect, it } from 'vitest';
import type { TeamInstallResult, TeamTemplate } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { seedAdvisors } from './state/advisors.js';

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

describe('team template routes (P2 #7)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('lists the catalog', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/teams/templates');
    expect(res.status).toBe(200);
    const list = (await res.json()) as TeamTemplate[];
    expect(list.length).toBeGreaterThan(0);
  });

  it('installs a team into a project', async () => {
    seedAdvisors(db);
    const app = makeApp(db);
    const res = await app.request('/api/teams/templates/ship-fast/install', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: '/tmp/proj' }),
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as TeamInstallResult;
    expect(result.ok).toBe(true);
    expect(result.advisorsEnabled).toContain('forge');
  });

  it('400s without a cwd', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/teams/templates/ship-fast/install', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('400s on an unknown template', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/teams/templates/nope/install', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: '/tmp/p' }),
    });
    expect(res.status).toBe(400);
  });
});
