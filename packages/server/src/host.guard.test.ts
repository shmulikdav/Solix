import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { isAllowedHost } from './origins.js';

/**
 * DNS-rebinding read exposure, measured on the published 1.18.3 on
 * 2026-11-03: with a foreign `Host` header and no `Origin` — exactly what a
 * rebound page's same-origin `fetch` sends — `GET /api/plans`,
 * `/api/missions` and `/api/system/governance` answered 200 with data.
 * Mutations were refused by the Origin gate; reads were not, because
 * nothing looked at the name the request was addressed to.
 */
describe('isAllowedHost', () => {
  it('accepts the names this instance is reachable by', () => {
    for (const h of ['127.0.0.1', '127.0.0.1:4242', 'localhost', 'localhost:4243', '[::1]:4242', '[::1]', 'LOCALHOST:4242', 'app.localhost', '127.1.2.3:4242']) {
      expect(isAllowedHost(h), h).toBe(true);
    }
  });

  it('refuses any other name', () => {
    for (const h of ['attacker.example', 'attacker.example:4242', '10.0.0.5:4242', 'localhost.attacker.example', 'evil-localhost', '[::2]:4242', '[::1', '']) {
      expect(isAllowedHost(h), h).toBe(false);
    }
  });

  /** Every browser sends Host; its absence is a non-browser caller. */
  it('allows a missing header', () => {
    expect(isAllowedHost(undefined)).toBe(true);
    expect(isAllowedHost(null)).toBe(true);
  });

  it('lets the operator add a LAN or tailnet name', () => {
    const env = { SOLIX_ALLOWED_HOSTS: 'my-laptop.tailnet, studio.lan' } as NodeJS.ProcessEnv;
    expect(isAllowedHost('my-laptop.tailnet:4242', env)).toBe(true);
    expect(isAllowedHost('STUDIO.LAN', env)).toBe(true);
    expect(isAllowedHost('other.lan', env)).toBe(false);
    expect(isAllowedHost('my-laptop.tailnet', {} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('CLAIM-HOST-IS-OURS — the API answers only to its own names', () => {
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
  });

  it('a read under a foreign Host is refused, with no Origin involved', async () => {
    for (const path of ['/api/plans', '/api/missions', '/api/system/governance', '/api/health']) {
      const res = await app.request(path, { headers: { host: 'attacker.example' } });
      expect(res.status, path).toBe(403);
      expect(((await res.json()) as { error: string }).error).toMatch(/hostname/);
    }
  });

  it('the same read under a loopback Host is served', async () => {
    for (const host of ['127.0.0.1:4242', 'localhost:4242', '[::1]:4242']) {
      const res = await app.request('/api/plans', { headers: { host } });
      expect(res.status, host).toBe(200);
    }
  });

  it('the Origin gate still refuses a cross-site mutation on a good Host', async () => {
    const res = await app.request('/api/goals', {
      method: 'POST',
      headers: { host: '127.0.0.1:4242', origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/cross-origin/);
  });

  it('the hooks, which post to 127.0.0.1, are unaffected', async () => {
    const res = await app.request('/events', {
      method: 'POST',
      headers: { host: '127.0.0.1:4242', 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'session_start', pid: 1, cwd: '/tmp/host-guard', ts: 1, payload: { session_id: 'h1', cwd: '/tmp/host-guard' } }),
    });
    // 401 is the token check, which runs after the Host gate let it through.
    expect(res.status).not.toBe(403);
  });
});
