import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';

/**
 * SPA fallback vs. missing assets.
 *
 * The catch-all used to return index.html (HTTP 200) for ANY unmatched path,
 * including files. A request for a texture that wasn't on disk therefore got
 * HTML with a 200; the browser tried to decode it as an image, the loader
 * threw, and the whole UI went blank. A missing file must 404 so it degrades
 * cleanly and is visible in devtools — while real client-side routes still get
 * index.html.
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

describe('static asset serving', () => {
  let db: DB;
  let dist: string;

  beforeEach(() => {
    dist = mkdtempSync(join(tmpdir(), 'solix-web-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>solix</title>');
    mkdirSync(join(dist, 'textures'), { recursive: true });
    writeFileSync(join(dist, 'textures', 'present.jpg'), 'JPEGDATA');
    process.env.SOLIX_WEB_DIST = dist;
    db = resetDbForTests();
  });

  afterEach(() => {
    delete process.env.SOLIX_WEB_DIST;
    rmSync(dist, { recursive: true, force: true });
  });

  it('404s a missing asset instead of returning index.html', async () => {
    const res = await makeApp(db).request('/textures/missing.jpg');
    expect(res.status).toBe(404);
    // Critically: it must NOT be HTML pretending to be an image.
    expect(res.headers.get('content-type') ?? '').not.toContain('text/html');
  });

  it('still serves an asset that exists', async () => {
    const res = await makeApp(db).request('/textures/present.jpg');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('JPEGDATA');
  });

  it('still serves index.html for the root and for client-side routes', async () => {
    const app = makeApp(db);
    expect((await app.request('/')).status).toBe(200);
    // An extensionless path is a route, not an asset → SPA fallback.
    const route = await app.request('/some/client/route');
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<!doctype html>');
  });

  it('404s a missing script/style too, not just images', async () => {
    const app = makeApp(db);
    expect((await app.request('/assets/gone.js')).status).toBe(404);
    expect((await app.request('/assets/gone.css')).status).toBe(404);
  });
});
