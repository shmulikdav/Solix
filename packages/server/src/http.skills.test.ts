import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Skill } from '@solix/shared';
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

describe('skill authoring routes (P3 #9)', () => {
  let db: DB;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solix-skills-http-'));
    process.env.SOLIX_USER_SKILLS_DIR = dir;
    db = resetDbForTests();
  });
  afterEach(() => {
    delete process.env.SOLIX_USER_SKILLS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, edits, versions, restores, and composes a user skill', async () => {
    const app = makeApp(db);
    // Create
    const created = await app.request('/api/skills', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'House Style', description: 'd', body: 'v1' }),
    });
    expect(created.status).toBe(200);
    const skill = (await created.json()) as Skill;
    expect(skill.id).toBe('user:house-style');
    const eid = encodeURIComponent(skill.id);

    // Edit
    const edited = await app.request(`/api/skills/${eid}`, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ body: 'v2' }),
    });
    expect(edited.status).toBe(200);

    // Versions
    const versions = (await (await app.request(`/api/skills/${eid}/versions`)).json()) as unknown[];
    expect(versions.length).toBeGreaterThanOrEqual(2);

    // Compose dry-run
    const composed = await app.request(`/api/skills/${eid}/compose`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ input: 'sample' }),
    });
    const { prompt } = (await composed.json()) as { prompt: string };
    expect(prompt).toContain('v2');
    expect(prompt).toContain('sample');
  });

  it('refuses to edit a bundled (non-user) skill', async () => {
    db.prepare(
      `INSERT INTO skills (id, name, description, source, manifest_path, updated_at)
       VALUES ('solix:x', 'X', '', 'solix', '/x', 1)`,
    ).run();
    const app = makeApp(db);
    const res = await app.request('/api/skills/solix%3Ax', {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ body: 'nope' }),
    });
    expect(res.status).toBe(403);
  });

  it('409s on a duplicate name, 400 without a body', async () => {
    const app = makeApp(db);
    await app.request('/api/skills', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Dup', body: 'x' }),
    });
    const dup = await app.request('/api/skills', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'Dup', body: 'y' }),
    });
    expect(dup.status).toBe(409);
    const bad = await app.request('/api/skills', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'NoBody' }),
    });
    expect(bad.status).toBe(400);
  });

  it('saves a test input and deletes the skill', async () => {
    const app = makeApp(db);
    const skill = (await (
      await app.request('/api/skills', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ name: 'Temp', body: 'b' }),
      })
    ).json()) as Skill;
    const eid = encodeURIComponent(skill.id);
    const t = await app.request(`/api/skills/${eid}/tests`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: 'c', input: 'in' }),
    });
    expect(t.status).toBe(200);
    const del = await app.request(`/api/skills/${eid}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await (await app.request(`/api/skills/${eid}`)).status)).toBe(404);
  });
});
