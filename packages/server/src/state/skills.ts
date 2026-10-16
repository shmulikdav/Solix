import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { Skill, SkillSource } from '@solix/shared';
import type { DB } from '../db.js';
import { userSkillsDir } from '../paths.js';
import { now } from '../util.js';

interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  source: SkillSource;
  manifest_path: string;
  installed_in_projects_json: string;
  updated_at: number;
}

function findSolixSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', '..', '..', 'skills'),
    resolve(here, '..', '..', 'skills'),
    resolve(process.cwd(), 'packages', 'skills'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

const SOLIX_SKILLS_DIR = findSolixSkillsDir();
const ANTHROPIC_SKILLS_DIR = join(homedir(), '.claude', 'skills');

interface ParsedManifest {
  id: string;
  name: string;
  description: string;
}

function parseSkillManifest(manifestPath: string, fallbackId: string): ParsedManifest | null {
  try {
    const txt = readFileSync(manifestPath, 'utf8');
    // Skill manifests use YAML frontmatter; we extract `name` and `description`.
    const match = txt.match(/^---\n([\s\S]*?)\n---/);
    let name = fallbackId;
    let description = '';
    if (match) {
      const fm = match[1] ?? '';
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      if (nameMatch) name = nameMatch[1]!.trim();
      if (descMatch) description = descMatch[1]!.trim();
    }
    return { id: fallbackId, name, description };
  } catch {
    return null;
  }
}

function rowToSkill(row: SkillRow): Skill {
  let installed: string[] = [];
  try {
    installed = JSON.parse(row.installed_in_projects_json) as string[];
  } catch {
    installed = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    source: row.source,
    manifestPath: row.manifest_path,
    installedInProjects: installed,
  };
}

export function discoverSkills(db: DB): Skill[] {
  const ts = now();
  const upsert = db.prepare(
    `INSERT INTO skills (id, name, description, source, manifest_path, installed_in_projects_json, updated_at)
     VALUES (?, ?, ?, ?, ?, '[]', ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       source = excluded.source,
       manifest_path = excluded.manifest_path,
       updated_at = excluded.updated_at`,
  );

  const sources: { dir: string; source: SkillSource }[] = [
    { dir: ANTHROPIC_SKILLS_DIR, source: 'anthropic' },
    { dir: SOLIX_SKILLS_DIR, source: 'solix' },
    { dir: userSkillsDir(), source: 'user' },
  ];

  for (const { dir, source } of sources) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const manifestPath = join(full, 'SKILL.md');
      if (!existsSync(manifestPath)) continue;
      const parsed = parseSkillManifest(manifestPath, entry);
      if (!parsed) continue;
      const id = `${source}:${parsed.id}`;
      upsert.run(
        id,
        parsed.name,
        parsed.description,
        source,
        manifestPath,
        ts,
      );
    }
  }

  return listSkills(db);
}

export function listSkills(db: DB): Skill[] {
  const rows = db
    .prepare('SELECT * FROM skills ORDER BY source ASC, name ASC')
    .all() as SkillRow[];
  return rows.map(rowToSkill);
}

export function getSkill(db: DB, id: string): Skill | null {
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as
    | SkillRow
    | undefined;
  return row ? rowToSkill(row) : null;
}

export function readSkillManifest(skill: Skill): string {
  if (!existsSync(skill.manifestPath)) return '';
  return readFileSync(skill.manifestPath, 'utf8');
}

export function recordSkillInstall(
  db: DB,
  skillId: string,
  projectId: string,
): Skill | null {
  const skill = getSkill(db, skillId);
  if (!skill) return null;
  const projects = new Set([...skill.installedInProjects, projectId]);
  db.prepare(
    'UPDATE skills SET installed_in_projects_json = ?, updated_at = ? WHERE id = ?',
  ).run(JSON.stringify([...projects]), now(), skillId);
  return getSkill(db, skillId);
}

export function getSolixSkillsDir(): string {
  return SOLIX_SKILLS_DIR;
}

export function getUserSkillsDir(): string {
  return userSkillsDir();
}

export function getAnthropicSkillsDir(): string {
  return ANTHROPIC_SKILLS_DIR;
}
