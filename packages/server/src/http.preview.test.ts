import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScheduledTask, TriggerKind } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { createPlan } from './state/plans.js';

/**
 * `Open preview ↗` rendered for every finished plan, including the Node and
 * Python templates offered in the same panel — which can never have an
 * `index.html`, so for those the button was guaranteed to land on a dead
 * end. That dead end then returned **HTTP 200** with no `<title>`, no link
 * back, and an unclosed `<body>`, in a chromeless popup with no address bar
 * (a non-empty third argument to `window.open`; `'noopener'` belongs in
 * `rel`).
 *
 * The client now asks first, and this is what it asks.
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
  return createHttpApp({
    db,
    router,
    orchestrator,
    fireSchedule: (_s: ScheduledTask, _t: TriggerKind) => ({ ok: true as const }),
  });
}

describe('GET /api/plans/:id/previewable', () => {
  let db: DB;
  let root: string;

  beforeEach(() => {
    db = resetDbForTests();
    root = mkdtempSync(join(tmpdir(), 'solix-preview-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function plan() {
    return createPlan(db, { name: 'p', goalPrompt: 'build', cwd: root });
  }

  it('says no for a project with no index.html', async () => {
    const p = plan();
    const res = await makeApp(db).request(`/api/plans/${p.id}/previewable`);
    expect(((await res.json()) as { previewable: boolean }).previewable).toBe(
      false,
    );
  });

  it('says yes once there is one', async () => {
    writeFileSync(join(root, 'index.html'), '<h1>built</h1>', 'utf8');
    const p = plan();
    const res = await makeApp(db).request(`/api/plans/${p.id}/previewable`);
    expect(((await res.json()) as { previewable: boolean }).previewable).toBe(
      true,
    );
  });

  it('says no for a plan it has never heard of', async () => {
    const res = await makeApp(db).request('/api/plans/nope/previewable');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { previewable: boolean }).previewable).toBe(
      false,
    );
  });
});

describe('the preview dead end', () => {
  let db: DB;
  let root: string;

  beforeEach(() => {
    db = resetDbForTests();
    root = mkdtempSync(join(tmpdir(), 'solix-deadend-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A 200 told the browser — and any crawler — that this went fine. */
  it('is a 404, not a 200', async () => {
    const p = createPlan(db, { name: 'p', goalPrompt: 'build', cwd: root });
    const res = await makeApp(db).request(`/api/plans/${p.id}/preview/`);
    expect(res.status).toBe(404);
  });

  it('has a title and a way back', async () => {
    const p = createPlan(db, { name: 'p', goalPrompt: 'build', cwd: root });
    const html = await (
      await makeApp(db).request(`/api/plans/${p.id}/preview/`)
    ).text();
    expect(html).toContain('<title>');
    expect(html).toMatch(/href="\/"/);
    expect(html).toContain('</html>');
  });

  it('serves the file when there is one', async () => {
    writeFileSync(join(root, 'index.html'), '<h1>built</h1>', 'utf8');
    const p = createPlan(db, { name: 'p', goalPrompt: 'build', cwd: root });
    const res = await makeApp(db).request(`/api/plans/${p.id}/preview/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('built');
  });
});
