import type { Project } from '@solix/shared';
import type { DB } from '../db.js';
import { hashCwd, now, projectNameFromCwd } from '../util.js';

interface ProjectRow {
  id: string;
  cwd: string;
  name: string;
  first_seen_at: number;
  last_active_at: number;
  managed: number | null;
  template: string | null;
}

function rowToProject(row: ProjectRow): Project {
  return {
    id: row.id,
    cwd: row.cwd,
    name: row.name,
    firstSeenAt: row.first_seen_at,
    lastActiveAt: row.last_active_at,
    managed: row.managed === 1 ? true : undefined,
    template: row.template ?? undefined,
  };
}

export function ensureProject(db: DB, cwd: string): Project {
  const id = hashCwd(cwd);
  const ts = now();
  const existing = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | undefined;

  if (existing) {
    db.prepare('UPDATE projects SET last_active_at = ? WHERE id = ?').run(
      ts,
      id,
    );
    return rowToProject({ ...existing, last_active_at: ts });
  }

  const name = projectNameFromCwd(cwd);
  db.prepare(
    `INSERT INTO projects (id, cwd, name, first_seen_at, last_active_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, cwd, name, ts, ts);

  return {
    id,
    cwd,
    name,
    firstSeenAt: ts,
    lastActiveAt: ts,
  };
}

export function listProjects(db: DB): Project[] {
  const rows = db
    .prepare('SELECT * FROM projects ORDER BY last_active_at DESC')
    .all() as ProjectRow[];
  return rows.map(rowToProject);
}

export function getProject(db: DB, id: string): Project | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined;
  return row ? rowToProject(row) : null;
}

/**
 * Register (or upgrade) a durable, user-created project — the build-studio
 * flow's persistence step, called AFTER the directory is scaffolded on disk.
 * If the cwd was already auto-observed, it is promoted to `managed`. The
 * filesystem/git side effects live in scaffold.ts (kept separate so this stays
 * a pure DB write).
 */
export function createManagedProject(
  db: DB,
  input: { cwd: string; name: string; template?: string },
): Project {
  const id = hashCwd(input.cwd);
  const ts = now();
  const existing = db
    .prepare('SELECT * FROM projects WHERE id = ?')
    .get(id) as ProjectRow | undefined;
  if (existing) {
    db.prepare(
      `UPDATE projects
         SET name = ?, managed = 1, template = ?, last_active_at = ?
       WHERE id = ?`,
    ).run(input.name, input.template ?? null, ts, id);
  } else {
    db.prepare(
      `INSERT INTO projects
         (id, cwd, name, first_seen_at, last_active_at, managed, template)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).run(id, input.cwd, input.name, ts, ts, input.template ?? null);
  }
  return getProject(db, id)!;
}
