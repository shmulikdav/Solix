import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Skill } from '@solix/shared';
import type { DB } from '../db.js';
import { userSkillsDir } from '../paths.js';
import { now, slugifyProjectName } from '../util.js';
import { getSkill } from './skills.js';

// ── Skill authoring (P3 #9) ────────────────────────────────────────────
// Create/edit/version/test USER skills (source 'user'), stored on disk under
// ~/.solix/skills/<slug>/SKILL.md so they survive restarts and are discovered
// like any other skill. Bundled anthropic/solix skills stay read-only — only
// `user:` skills are editable here. All file writes are confined to the user
// skills dir (slug-sanitized; no path traversal).

export const USER_SKILL_PREFIX = 'user:';

export interface UserSkillInput {
  name: string;
  description?: string;
  body: string;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  ordinal: number;
  name: string;
  description: string;
  body: string;
  createdAt: number;
}

export interface SkillTest {
  id: string;
  skillId: string;
  name: string;
  input: string;
  createdAt: number;
}

export function isUserSkill(id: string): boolean {
  return id.startsWith(USER_SKILL_PREFIX);
}

function slugOf(id: string): string {
  return id.slice(USER_SKILL_PREFIX.length);
}

function skillDir(slug: string): string {
  return join(userSkillsDir(), slug);
}

function manifestPathFor(slug: string): string {
  return join(skillDir(slug), 'SKILL.md');
}

/** Compose the on-disk SKILL.md (YAML frontmatter + body). */
export function renderSkillManifest(input: UserSkillInput): string {
  const name = input.name.trim();
  const description = (input.description ?? '').trim();
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${input.body.trim()}\n`;
}

/** Parse the body (everything after the frontmatter) back out of a manifest. */
export function extractSkillBody(manifest: string): string {
  const m = manifest.match(/^---\n[\s\S]*?\n---\n?/);
  return (m ? manifest.slice(m[0].length) : manifest).trim();
}

function writeManifest(slug: string, input: UserSkillInput): string {
  const dir = skillDir(slug);
  mkdirSync(dir, { recursive: true });
  const path = manifestPathFor(slug);
  writeFileSync(path, renderSkillManifest(input), 'utf8');
  return path;
}

function nextOrdinal(db: DB, skillId: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(ordinal), 0) AS max FROM skill_versions WHERE skill_id = ?')
    .get(skillId) as { max: number };
  return (row.max ?? 0) + 1;
}

function snapshot(db: DB, skillId: string, input: UserSkillInput): SkillVersion {
  const id = randomUUID();
  const ts = now();
  const ordinal = nextOrdinal(db, skillId);
  db.prepare(
    `INSERT INTO skill_versions (id, skill_id, ordinal, name, description, body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, skillId, ordinal, input.name.trim(), (input.description ?? '').trim(), input.body, ts);
  return {
    id,
    skillId,
    ordinal,
    name: input.name.trim(),
    description: (input.description ?? '').trim(),
    body: input.body,
    createdAt: ts,
  };
}

/**
 * Create a new user skill: write its SKILL.md, register it (source 'user'),
 * and snapshot v1. Returns null if the name slugifies to an id that already
 * exists (caller should pick another name).
 */
export function createUserSkill(db: DB, input: UserSkillInput): Skill | null {
  const name = input.name.trim();
  if (!name || !input.body.trim()) return null;
  const slug = slugifyProjectName(name);
  const id = `${USER_SKILL_PREFIX}${slug}`;
  if (getSkill(db, id)) return null; // name collision
  const manifestPath = writeManifest(slug, input);
  db.prepare(
    `INSERT INTO skills (id, name, description, source, manifest_path, installed_in_projects_json, updated_at)
     VALUES (?, ?, ?, 'user', ?, '[]', ?)`,
  ).run(id, name, (input.description ?? '').trim(), manifestPath, now());
  snapshot(db, id, input);
  return getSkill(db, id);
}

/**
 * Update a user skill. Snapshots the CURRENT on-disk content first (so the prior
 * state is restorable), then writes the new content. Only `user:` skills are
 * editable. Returns null if not an editable user skill.
 */
export function updateUserSkill(
  db: DB,
  id: string,
  patch: Partial<UserSkillInput>,
): Skill | null {
  const skill = getSkill(db, id);
  if (!skill || skill.source !== 'user' || !isUserSkill(id)) return null;
  const slug = slugOf(id);
  // Snapshot current state before overwriting.
  const currentBody = existsSync(skill.manifestPath)
    ? extractSkillBody(readFileSync(skill.manifestPath, 'utf8'))
    : '';
  snapshot(db, id, {
    name: skill.name,
    description: skill.description,
    body: currentBody,
  });
  const next: UserSkillInput = {
    name: (patch.name ?? skill.name).trim(),
    description: (patch.description ?? skill.description).trim(),
    body: patch.body ?? currentBody,
  };
  const manifestPath = writeManifest(slug, next);
  db.prepare(
    `UPDATE skills SET name = ?, description = ?, manifest_path = ?, updated_at = ? WHERE id = ?`,
  ).run(next.name, next.description, manifestPath, now(), id);
  return getSkill(db, id);
}

export function listSkillVersions(db: DB, skillId: string): SkillVersion[] {
  const rows = db
    .prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY ordinal DESC')
    .all(skillId) as Array<{
    id: string;
    skill_id: string;
    ordinal: number;
    name: string;
    description: string | null;
    body: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    skillId: r.skill_id,
    ordinal: r.ordinal,
    name: r.name,
    description: r.description ?? '',
    body: r.body,
    createdAt: r.created_at,
  }));
}

/** Restore a prior version as the current content (snapshotting current first). */
export function restoreSkillVersion(
  db: DB,
  id: string,
  versionId: string,
): Skill | null {
  const skill = getSkill(db, id);
  if (!skill || skill.source !== 'user') return null;
  const row = db
    .prepare('SELECT * FROM skill_versions WHERE id = ? AND skill_id = ?')
    .get(versionId, id) as
    | { name: string; description: string | null; body: string }
    | undefined;
  if (!row) return null;
  return updateUserSkill(db, id, {
    name: row.name,
    description: row.description ?? '',
    body: row.body,
  });
}

export function deleteUserSkill(db: DB, id: string): boolean {
  const skill = getSkill(db, id);
  if (!skill || skill.source !== 'user' || !isUserSkill(id)) return false;
  try {
    rmSync(skillDir(slugOf(id)), { recursive: true, force: true });
  } catch {
    /* best-effort file cleanup */
  }
  db.prepare('DELETE FROM skill_versions WHERE skill_id = ?').run(id);
  db.prepare('DELETE FROM skill_tests WHERE skill_id = ?').run(id);
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
  return true;
}

// ── Saved test inputs + compose preview ────────────────────────────────

export function saveSkillTest(
  db: DB,
  skillId: string,
  input: { name: string; input: string },
): SkillTest {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO skill_tests (id, skill_id, name, input, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(id, skillId, input.name.trim() || 'test', input.input, ts);
  return { id, skillId, name: input.name.trim() || 'test', input: input.input, createdAt: ts };
}

export function listSkillTests(db: DB, skillId: string): SkillTest[] {
  const rows = db
    .prepare('SELECT * FROM skill_tests WHERE skill_id = ? ORDER BY created_at ASC')
    .all(skillId) as Array<{
    id: string;
    skill_id: string;
    name: string;
    input: string;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    skillId: r.skill_id,
    name: r.name,
    input: r.input,
    createdAt: r.created_at,
  }));
}

export function deleteSkillTest(db: DB, testId: string): boolean {
  return db.prepare('DELETE FROM skill_tests WHERE id = ?').run(testId).changes > 0;
}

/**
 * Compose the prompt a skill would produce for a given input — the local,
 * model-free "dry run" of a skill test. Pure string composition (the skill's
 * body as the instruction, the input delimited as untrusted data), so it's
 * fully testable without a live model.
 */
export function composeSkillTest(body: string, input: string): string {
  return (
    `${body.trim()}\n\n` +
    `=== INPUT (data to apply the skill to) ===\n${input.trim()}`
  );
}
