import { beforeEach, describe, expect, it } from 'vitest';
import type { Notifier } from '@solix/shared';
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

describe('notifier routes (P3 #11)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('creates a slack notifier and never returns the webhook', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/notifiers', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        provider: 'slack',
        name: 'Eng',
        config: { webhookUrl: 'https://hooks.slack.com/SECRET' },
        events: ['plan_completed'],
      }),
    });
    expect(res.status).toBe(200);
    const n = (await res.json()) as Notifier;
    expect(n.provider).toBe('slack');
    expect(JSON.stringify(n)).not.toContain('SECRET');

    const list = await (await app.request('/api/notifiers')).json();
    expect(JSON.stringify(list)).not.toContain('SECRET');
  });

  it('validates provider + config', async () => {
    const app = makeApp(db);
    const bad = await app.request('/api/notifiers', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: 'slack', name: 'x', config: {} }),
    });
    expect(bad.status).toBe(400);
    const badProvider = await app.request('/api/notifiers', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ provider: 'carrier-pigeon', name: 'x', config: {} }),
    });
    expect(badProvider.status).toBe(400);
  });

  it('toggles and deletes a notifier', async () => {
    const app = makeApp(db);
    const n = (await (
      await app.request('/api/notifiers', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          provider: 'telegram',
          name: 'T',
          config: { botToken: 'x', chatId: '1' },
          events: [],
        }),
      })
    ).json()) as Notifier;

    const toggled = await app.request(`/api/notifiers/${n.id}/toggle`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(toggled.status).toBe(200);
    expect(((await toggled.json()) as Notifier).enabled).toBe(false);

    const del = await app.request(`/api/notifiers/${n.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
  });
});
