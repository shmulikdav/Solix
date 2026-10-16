import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, resetDbForTests } from './db.js';
import { getSession } from './state/sessions.js';
import { listPlansForOrg } from './state/plans.js';
import { listGoalsForOrg } from './state/goals.js';
import { listDueSchedules } from './state/schedules.js';
import { DEFAULT_ORG_ID } from './state/orgs.js';

/**
 * Upgrade-in-place test against a POPULATED pre-v2 database.
 *
 * Every other test runs applySchema on an empty in-memory DB, which proves the
 * schema is creatable but says nothing about migrating a real user's
 * ~/.solix/solix.db that already holds months of rows. This builds a legacy
 * database by hand — old column sets, the old sessions.origin CHECK — fills it
 * with data, then opens it through the real migration path and asserts the data
 * survived and the new columns/tables landed with correct defaults.
 */

// The pre-v2 schema: no kind/advisor_role/plan back-links on sessions, no
// base_ref/budget_warned/org_id on plans, no delegation/result columns on
// plan_tasks, no org_id on goals, no trigger/owner/token on scheduled_tasks,
// and the legacy origin CHECK that once broke Agent View sync.
const LEGACY_SCHEMA = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  pid INTEGER,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_session_id TEXT REFERENCES sessions(id),
  origin TEXT NOT NULL CHECK (origin IN ('external','internal')),
  model TEXT,
  status TEXT NOT NULL,
  context_usage_pct REAL DEFAULT 0,
  orbit_slot INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminated_at INTEGER
);
CREATE TABLE advisors (
  id TEXT PRIMARY KEY, role TEXT NOT NULL, codename TEXT NOT NULL,
  name TEXT NOT NULL, description TEXT NOT NULL, glyph TEXT, color TEXT,
  default_model TEXT, agent_md_path TEXT NOT NULL,
  required_skills_json TEXT DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0, pinned_session_id TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE missions (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  prompt TEXT NOT NULL, short_name TEXT, long_summary TEXT,
  status TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
  duration_ms INTEGER, total_tokens INTEGER, lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0, subagent_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0, files_touched_json TEXT DEFAULT '[]'
);
CREATE TABLE goals (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  color TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE scheduled_tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  prompt TEXT NOT NULL, cron TEXT NOT NULL, enabled INTEGER DEFAULT 1,
  last_run_at INTEGER, next_run_at INTEGER NOT NULL
);
CREATE TABLE plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, goal_prompt TEXT NOT NULL,
  status TEXT NOT NULL, auto_mode INTEGER NOT NULL DEFAULT 0, goal_id TEXT,
  cwd TEXT NOT NULL, budget_usd REAL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE plan_tasks (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
  title TEXT NOT NULL, prompt TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]', assigned_advisor_role TEXT,
  cwd TEXT, model TEXT, budget_usd REAL, session_id TEXT, mission_id TEXT,
  verifier_session_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, mission_id TEXT,
  tool TEXT NOT NULL, args_json TEXT, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, completed_at INTEGER
);
CREATE TABLE skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
  source TEXT NOT NULL CHECK (source IN ('anthropic','solix','user')),
  manifest_path TEXT NOT NULL, installed_in_projects_json TEXT DEFAULT '[]',
  updated_at INTEGER NOT NULL
);
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  session_id TEXT, advisor_id TEXT, project_id TEXT, summary TEXT NOT NULL,
  payload_json TEXT
);
CREATE TABLE galaxy_imports (
  id TEXT PRIMARY KEY, source_url TEXT, manifest_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL
);
CREATE TABLE galaxy_versions (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, ordinal INTEGER NOT NULL,
  name TEXT NOT NULL, author TEXT, description TEXT, manifest_json TEXT NOT NULL
);
`;

function buildLegacyDb(path: string): void {
  const db = new Database(path);
  db.exec(LEGACY_SCHEMA);
  db.prepare(
    'INSERT INTO projects (id,cwd,name,first_seen_at,last_active_at) VALUES (?,?,?,?,?)',
  ).run('proj1', '/legacy/repo', 'legacy-repo', 1, 2);
  db.prepare(
    `INSERT INTO sessions (id,pid,project_id,origin,model,status,orbit_slot,cwd,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run('sess-legacy', 123, 'proj1', 'external', 'opus', 'idle', 0, '/legacy/repo', 1, 2);
  db.prepare(
    `INSERT INTO plans (id,name,goal_prompt,status,auto_mode,cwd,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run('plan-legacy', 'Legacy plan', 'ship it', 'completed', 0, '/legacy/repo', 1, 2);
  db.prepare(
    `INSERT INTO plan_tasks (id,plan_id,title,prompt,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('task-legacy', 'plan-legacy', 'Legacy task', 'do it', 'completed', 1, 2);
  db.prepare(
    'INSERT INTO goals (id,name,color,created_at) VALUES (?,?,?,?)',
  ).run('goal-legacy', 'Legacy goal', '#fff', 1);
  db.prepare(
    `INSERT INTO scheduled_tasks (id,project_id,prompt,cron,enabled,next_run_at)
     VALUES (?,?,?,?,?,?)`,
  ).run('sched-legacy', 'proj1', 'nightly', '1d', 1, 1); // next_run_at in the past → due
  db.close();
}

function columns(db: ReturnType<typeof resetDbForTests>, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name,
  );
}

describe('migrating a populated legacy database', () => {
  let dir: string;
  afterEach(() => {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('upgrades in place: data survives, columns + tables land with defaults', () => {
    dir = mkdtempSync(join(tmpdir(), 'solix-legacy-'));
    const path = join(dir, 'legacy.db');
    buildLegacyDb(path);

    // The real migration path.
    const db = resetDbForTests(path);

    // ── Legacy rows survived ──
    expect(getSession(db, 'sess-legacy')?.cwd).toBe('/legacy/repo');
    expect(
      (db.prepare('SELECT COUNT(*) n FROM plan_tasks').get() as { n: number }).n,
    ).toBe(1);

    // ── ensureColumn added the new columns ──
    expect(columns(db, 'sessions')).toEqual(
      expect.arrayContaining(['kind', 'advisor_role', 'plan_id', 'plan_task_id', 'runtime', 'cost_usd']),
    );
    expect(columns(db, 'plans')).toEqual(
      expect.arrayContaining(['base_ref', 'budget_warned', 'org_id']),
    );
    expect(columns(db, 'plan_tasks')).toEqual(
      expect.arrayContaining(['last_error', 'result_summary', 'runtime', 'max_attempts', 'delegation_depth']),
    );
    expect(columns(db, 'goals')).toEqual(expect.arrayContaining(['org_id']));
    expect(columns(db, 'scheduled_tasks')).toEqual(
      expect.arrayContaining(['cwd', 'name', 'trigger', 'owner', 'token']),
    );
    expect(columns(db, 'projects')).toEqual(
      expect.arrayContaining(['managed', 'template']),
    );

    // ── NOT NULL columns got sane defaults on EXISTING rows ──
    const task = db
      .prepare('SELECT max_attempts, delegation_depth FROM plan_tasks WHERE id=?')
      .get('task-legacy') as { max_attempts: number; delegation_depth: number };
    expect(task.max_attempts).toBe(3);
    expect(task.delegation_depth).toBe(0);
    const plan = db
      .prepare('SELECT budget_warned FROM plans WHERE id=?')
      .get('plan-legacy') as { budget_warned: number };
    expect(plan.budget_warned).toBe(0);
    // A legacy routine is treated as an interval trigger, so it still fires.
    const sched = db
      .prepare('SELECT trigger FROM scheduled_tasks WHERE id=?')
      .get('sched-legacy') as { trigger: string };
    expect(sched.trigger).toBe('interval');
    expect(listDueSchedules(db, Date.now()).map((s) => s.id)).toContain('sched-legacy');

    // ── New tables exist ──
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'task_thread_entries',
        'connections',
        'secrets',
        'connection_grants',
        'schedule_runs',
        'notifiers',
        'orgs',
        'app_settings',
        'skill_versions',
        'skill_tests',
      ]),
    );

    // ── The legacy origin CHECK was relaxed (this once broke Agent View) ──
    expect(() =>
      db
        .prepare(
          `INSERT INTO sessions (id,pid,project_id,origin,model,status,orbit_slot,cwd,created_at,updated_at)
           VALUES ('sess-av',1,'proj1','agentview','opus','idle',1,'/legacy/repo',1,2)`,
        )
        .run(),
    ).not.toThrow();

    // ── Pre-migration rows read as belonging to the default org ──
    expect(listPlansForOrg(db, DEFAULT_ORG_ID).map((p) => p.id)).toContain('plan-legacy');
    expect(listGoalsForOrg(db, DEFAULT_ORG_ID).map((g) => g.id)).toContain('goal-legacy');
  });

  it('is idempotent — migrating an already-migrated database is a no-op', () => {
    dir = mkdtempSync(join(tmpdir(), 'solix-legacy2-'));
    const path = join(dir, 'legacy.db');
    buildLegacyDb(path);
    resetDbForTests(path);
    closeDb();
    // Second pass over the same file must not throw or lose data.
    const db = resetDbForTests(path);
    expect(getSession(db, 'sess-legacy')).not.toBeNull();
    expect(listPlansForOrg(db, DEFAULT_ORG_ID).map((p) => p.id)).toContain('plan-legacy');
  });
});
