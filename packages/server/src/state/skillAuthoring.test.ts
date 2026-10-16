import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDbForTests, type DB } from '../db.js';
import { getSkill } from './skills.js';
import {
  composeSkillTest,
  createUserSkill,
  deleteSkillTest,
  deleteUserSkill,
  extractSkillBody,
  isUserSkill,
  listSkillTests,
  listSkillVersions,
  restoreSkillVersion,
  renderSkillManifest,
  saveSkillTest,
  updateUserSkill,
} from './skillAuthoring.js';

describe('skill authoring (P3 #9)', () => {
  let db: DB;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'solix-skills-'));
    process.env.SOLIX_USER_SKILLS_DIR = dir;
    db = resetDbForTests();
  });
  afterEach(() => {
    delete process.env.SOLIX_USER_SKILLS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it('renders + re-parses a manifest round-trip', () => {
    const manifest = renderSkillManifest({
      name: 'Tidy',
      description: 'd',
      body: 'Do the thing.',
    });
    expect(manifest).toContain('name: Tidy');
    expect(extractSkillBody(manifest)).toBe('Do the thing.');
  });

  it('creates a user skill, writes SKILL.md, and snapshots v1', () => {
    const skill = createUserSkill(db, {
      name: 'Commit Style',
      description: 'house commit format',
      body: 'Write commits in imperative mood.',
    })!;
    expect(skill).not.toBeNull();
    expect(skill.id).toBe('user:commit-style');
    expect(skill.source).toBe('user');
    expect(isUserSkill(skill.id)).toBe(true);
    expect(existsSync(skill.manifestPath)).toBe(true);
    expect(readFileSync(skill.manifestPath, 'utf8')).toContain('imperative mood');
    const versions = listSkillVersions(db, skill.id);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.ordinal).toBe(1);
  });

  it('rejects a duplicate name', () => {
    createUserSkill(db, { name: 'Dup', body: 'x' });
    expect(createUserSkill(db, { name: 'Dup', body: 'y' })).toBeNull();
  });

  it('updates a skill and snapshots the prior version; restore brings it back', () => {
    const skill = createUserSkill(db, { name: 'Edit Me', body: 'v1 body' })!;
    updateUserSkill(db, skill.id, { body: 'v2 body' });
    expect(readFileSync(getSkill(db, skill.id)!.manifestPath, 'utf8')).toContain('v2 body');
    // Two versions now: v1 (snapshotted at create) + the pre-update snapshot.
    const versions = listSkillVersions(db, skill.id);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    // Restore the oldest (v1 body).
    const v1 = versions[versions.length - 1]!;
    restoreSkillVersion(db, skill.id, v1.id);
    expect(readFileSync(getSkill(db, skill.id)!.manifestPath, 'utf8')).toContain('v1 body');
  });

  it('refuses to edit or delete a non-user skill', () => {
    // Seed a bundled skill row directly.
    db.prepare(
      `INSERT INTO skills (id, name, description, source, manifest_path, updated_at)
       VALUES ('solix:x', 'X', '', 'solix', '/x', 1)`,
    ).run();
    expect(updateUserSkill(db, 'solix:x', { body: 'nope' })).toBeNull();
    expect(deleteUserSkill(db, 'solix:x')).toBe(false);
  });

  it('deletes a user skill with its versions, tests, and files', () => {
    const skill = createUserSkill(db, { name: 'Gone', body: 'b' })!;
    saveSkillTest(db, skill.id, { name: 't', input: 'i' });
    expect(deleteUserSkill(db, skill.id)).toBe(true);
    expect(getSkill(db, skill.id)).toBeNull();
    expect(listSkillVersions(db, skill.id)).toHaveLength(0);
    expect(listSkillTests(db, skill.id)).toHaveLength(0);
    expect(existsSync(skill.manifestPath)).toBe(false);
  });

  it('saves + lists + deletes test inputs', () => {
    const skill = createUserSkill(db, { name: 'Tested', body: 'b' })!;
    const t = saveSkillTest(db, skill.id, { name: 'case1', input: 'hello' });
    expect(listSkillTests(db, skill.id)).toHaveLength(1);
    expect(deleteSkillTest(db, t.id)).toBe(true);
    expect(listSkillTests(db, skill.id)).toHaveLength(0);
  });

  it('composes a dry-run prompt with the input delimited as data', () => {
    const prompt = composeSkillTest('Apply the house style.', 'raw input');
    expect(prompt).toContain('Apply the house style.');
    expect(prompt).toContain('INPUT (data');
    expect(prompt).toContain('raw input');
  });
});
