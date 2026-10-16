import { beforeEach, describe, expect, it } from 'vitest';
import type { Org, StorageStatus } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';

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

describe('org + storage routes (P3 #10)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('lists orgs with a default + current, creates + switches', async () => {
    const app = makeApp(db);
    const initial = (await (await app.request('/api/orgs')).json()) as {
      orgs: Org[];
      currentOrgId: string;
    };
    expect(initial.orgs.length).toBeGreaterThanOrEqual(1);
    expect(initial.currentOrgId).toBe('org-default');

    const created = (await (
      await app.request('/api/orgs', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'Acme' }),
      })
    ).json()) as Org;

    const switched = await app.request('/api/orgs/current', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ orgId: created.id }),
    });
    expect(switched.status).toBe(200);
    const after = (await (await app.request('/api/orgs')).json()) as {
      currentOrgId: string;
    };
    expect(after.currentOrgId).toBe(created.id);
  });

  it('refuses switching to an unknown org', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/orgs/current', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ orgId: 'nope' }),
    });
    expect(res.status).toBe(400);
  });

  it('refuses deleting the default org', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/orgs/org-default', { method: 'DELETE' });
    expect(res.status).toBe(400);
  });

  it('reports storage status', async () => {
    const app = makeApp(db);
    const s = (await (await app.request('/api/system/storage')).json()) as StorageStatus;
    expect(s.active).toBe('sqlite');
    expect(typeof s.note).toBe('string');
  });
});
