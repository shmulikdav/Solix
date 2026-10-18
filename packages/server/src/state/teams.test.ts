import { describe, it, expect, beforeEach } from 'vitest';
import { resetDbForTests, type DB } from '../db.js';
import { seedAdvisors, getAdvisor } from './advisors.js';
import { getSkill } from './skills.js';
import { listSchedules } from './schedules.js';

import {
  getTeamTemplate,
  installTeamTemplate,
  listTeamTemplates,
} from './teams.js';
import { now } from '../util.js';

function seedSkill(db: DB, id: string, name: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO skills (id, name, description, source, manifest_path, updated_at)
     VALUES (?, ?, '', 'solix', '/x', ?)`,
  ).run(id, name, now());
}

describe('team templates (P2 #7)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('exposes a non-empty catalog with well-formed entries', () => {
    const list = listTeamTemplates();
    expect(list.length).toBeGreaterThan(0);
    for (const t of list) {
      expect(t.id).toBeTruthy();
      expect(Array.isArray(t.advisors)).toBe(true);
      expect(Array.isArray(t.skills)).toBe(true);
      expect(Array.isArray(t.routines)).toBe(true);
    }
    expect(getTeamTemplate('ship-fast')).not.toBeNull();
    expect(getTeamTemplate('nope')).toBeNull();
  });

  it('enables advisors, installs skills, and creates routines', () => {
    seedAdvisors(db); // real advisor roster (forge, lumen, argus, mira, …)
    seedSkill(db, 'mission-summary', 'mission-summary');

    const res = installTeamTemplate(db, 'ship-fast', { cwd: '/tmp/proj' });
    expect(res.ok).toBe(true);
    // ship-fast = forge + lumen + argus + mira.
    expect(res.advisorsEnabled.sort()).toEqual(['argus', 'forge', 'lumen', 'mira']);
    for (const id of res.advisorsEnabled) {
      expect(getAdvisor(db, id)!.enabled).toBe(true);
    }
    // The skill was installed into the project.
    expect(res.skillsInstalled).toEqual(['mission-summary']);
    expect(getSkill(db, 'mission-summary')!.installedInProjects.length).toBe(1);
    // The daily backlog routine was created in the project.
    expect(res.routinesCreated).toHaveLength(1);
    const sched = listSchedules(db).find((s) => s.id === res.routinesCreated[0]);
    expect(sched?.owner).toBe('ship-fast');
    expect(sched?.cwd).toBe('/tmp/proj');
  });

  it('warns (not fails) when an advisor or skill is missing', () => {
    // No advisors/skills seeded → every piece is skipped with a warning.
    const res = installTeamTemplate(db, 'ship-fast', { cwd: '/tmp/proj' });
    expect(res.ok).toBe(true);
    expect(res.advisorsEnabled).toHaveLength(0);
    expect(res.skillsInstalled).toHaveLength(0);
    expect(res.warnings.length).toBeGreaterThan(0);
    // Routines still get created (they don't depend on a catalog).
    expect(res.routinesCreated).toHaveLength(1);
  });

  it('can decline the routines while still taking advisors + skills', () => {
    seedAdvisors(db);
    seedSkill(db, 'mission-summary', 'mission-summary');
    const res = installTeamTemplate(db, 'ship-fast', {
      cwd: '/tmp/proj',
      includeRoutines: false,
    });
    expect(res.ok).toBe(true);
    // The parts with no ongoing effect still applied…
    expect(res.advisorsEnabled.length).toBeGreaterThan(0);
    expect(res.skillsInstalled).toEqual(['mission-summary']);
    // …but no recurring agent run was scheduled.
    expect(res.routinesCreated).toHaveLength(0);
    expect(listSchedules(db)).toHaveLength(0);
    expect(res.warnings.some((w) => /declined/.test(w))).toBe(true);
  });

  it('creates routines by default (unchanged behaviour)', () => {
    const res = installTeamTemplate(db, 'ship-fast', { cwd: '/tmp/proj' });
    expect(res.routinesCreated).toHaveLength(1);
  });

  it('fails cleanly on an unknown template or missing cwd', () => {
    expect(installTeamTemplate(db, 'nope', { cwd: '/tmp/p' }).ok).toBe(false);
    expect(installTeamTemplate(db, 'ship-fast', { cwd: '' }).ok).toBe(false);
  });
});
