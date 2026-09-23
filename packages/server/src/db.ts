import Database from 'better-sqlite3';
import { DB_PATH, ensureSolixHome } from './paths.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  pid INTEGER,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_session_id TEXT REFERENCES sessions(id),
  -- origin is enforced at the app layer via the SessionOrigin union
  -- ('external' | 'internal' | 'agentview', and future multi-tool origins
  -- like 'codex'). We deliberately do NOT put a CHECK here: SQLite can't
  -- ALTER a CHECK, so every new origin value would otherwise require a
  -- table-rebuild migration — and a stale CHECK once silently broke Agent
  -- View sync for months. The migration in getDb() relaxes it on old DBs.
  origin TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL,
  context_usage_pct REAL DEFAULT 0,
  orbit_slot INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  name TEXT,
  kind TEXT NOT NULL DEFAULT 'user',
  advisor_role TEXT,
  current_mission_id TEXT,
  last_completed_mission_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  terminated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_kind ON sessions(kind);

CREATE TABLE IF NOT EXISTS advisors (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  codename TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  glyph TEXT,
  color TEXT,
  default_model TEXT,
  agent_md_path TEXT NOT NULL,
  required_skills_json TEXT DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  pinned_session_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL CHECK (source IN ('anthropic','solix','user')),
  manifest_path TEXT NOT NULL,
  installed_in_projects_json TEXT DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS galaxy_imports (
  id TEXT PRIMARY KEY,
  source_url TEXT,
  manifest_json TEXT NOT NULL,
  imported_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  session_id TEXT,
  advisor_id TEXT,
  project_id TEXT,
  summary TEXT NOT NULL,
  payload_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_events(ts);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id);

CREATE TABLE IF NOT EXISTS galaxy_versions (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  author TEXT,
  description TEXT,
  manifest_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_galaxy_versions_ts ON galaxy_versions(ts);

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  prompt TEXT NOT NULL,
  short_name TEXT,
  long_summary TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  total_tokens INTEGER,
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  subagent_count INTEGER DEFAULT 0,
  tool_call_count INTEGER DEFAULT 0,
  files_touched_json TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_missions_session ON missions(session_id);
CREATE INDEX IF NOT EXISTS idx_missions_completed_at ON missions(completed_at);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  mission_id TEXT,
  tool TEXT NOT NULL,
  args_json TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  prompt TEXT NOT NULL,
  cron TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- v2 Maestro orchestrator: a Plan is a goal decomposed into a DAG of tasks.
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  goal_prompt TEXT NOT NULL,
  status TEXT NOT NULL,
  auto_mode INTEGER NOT NULL DEFAULT 0,
  goal_id TEXT,
  cwd TEXT NOT NULL,
  budget_usd REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);

CREATE TABLE IF NOT EXISTS plan_tasks (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  assigned_advisor_role TEXT,
  cwd TEXT,
  model TEXT,
  budget_usd REAL,
  session_id TEXT,
  mission_id TEXT,
  verifier_session_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_plan ON plan_tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_plan_tasks_status ON plan_tasks(status);

-- v2 Maestro — tool_calls hot paths (reaper). (The sessions.plan_id /
-- plan_task_id indexes are created in applySchema() AFTER ensureColumn adds
-- those columns — they don't exist in the base sessions table.)
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_status ON tool_calls(status);
`;

export type DB = Database.Database;

let _db: DB | null = null;

interface PragmaColumn {
  name: string;
}

function ensureColumn(
  db: DB,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as PragmaColumn[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

/**
 * One-time relaxation of the legacy `sessions.origin` CHECK constraint.
 *
 * DBs created before this fix declared
 *   origin TEXT NOT NULL CHECK (origin IN ('external','internal'))
 * which rejects Agent View sessions (`origin = 'agentview'`) — so every
 * Agent View sync threw `CHECK constraint failed` and no background session
 * ever appeared as a planet. SQLite can't ALTER an existing table's CHECK,
 * and better-sqlite3 forbids editing sqlite_master directly, so we use the
 * standard table-rebuild: recreate `sessions` from its OWN stored DDL minus
 * the CHECK, copy every row across, and swap it in.
 *
 * SQLite keeps the *full* current DDL for a table in sqlite_master — every
 * `ALTER TABLE ... ADD COLUMN` from prior upgrades is folded into it — so
 * rebuilding from that DDL preserves all columns, types, and defaults with
 * no hand-maintained column list. Data-preserving and column-order agnostic.
 *
 * Best-effort: the whole rebuild runs in a transaction (rolled back on any
 * error) with FK enforcement disabled around it (so dropping the referenced
 * `sessions` table is allowed). On failure the original table is untouched
 * and boot continues — Agent View simply stays unsynced, exactly as before.
 */
function relaxLegacyOriginCheck(db: DB): void {
  let ddl = '';
  try {
    const row = db
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='sessions'`,
      )
      .get() as { sql?: string } | undefined;
    ddl = row?.sql ?? '';
  } catch {
    return;
  }
  if (!/CHECK\s*\(\s*origin\s+IN/i.test(ddl)) return; // already relaxed / new DB

  const relaxed = ddl.replace(
    /,?\s*CHECK\s*\(\s*origin\s+IN\s*\([^)]*\)\s*\)/i,
    '',
  );
  if (relaxed === ddl) return; // couldn't excise cleanly — leave untouched

  // Recreate under a temp name (keep every column + the now-CHECK-free
  // constraints exactly as they were), copy, drop, rename.
  const tempDdl = relaxed.replace(
    /CREATE\s+TABLE\s+(?:"sessions"|`sessions`|\[sessions\]|sessions)/i,
    'CREATE TABLE "_sessions_migrate_new"',
  );
  if (!tempDdl.includes('_sessions_migrate_new')) return; // rename failed — bail

  const cols = (
    db.prepare(`PRAGMA table_info(sessions)`).all() as { name: string }[]
  )
    .map((c) => `"${c.name}"`)
    .join(', ');

  // FK enforcement can only be toggled outside a transaction.
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(tempDdl);
      db.exec(
        `INSERT INTO "_sessions_migrate_new" (${cols}) SELECT ${cols} FROM sessions`,
      );
      db.exec(`DROP TABLE sessions`);
      db.exec(`ALTER TABLE "_sessions_migrate_new" RENAME TO sessions`);
      // Indexes were dropped with the old table — recreate them.
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`,
      );
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)`,
      );
      db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_kind ON sessions(kind)`);
    })();
    console.log('[solix] migrated sessions.origin CHECK (Agent View enabled)');
  } catch (err) {
    console.warn(
      '[solix] origin CHECK migration skipped:',
      (err as Error).message,
    );
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

/** Apply pragmas + schema + all idempotent migrations to a freshly-opened DB.
 *  Shared by getDb() (real ~/.solix DB) and resetDbForTests() (isolated DB). */
function applySchema(db: DB): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  relaxLegacyOriginCheck(db);
  // Idempotent column adds for repos upgrading from M0+M1.
  ensureColumn(db, 'sessions', 'kind', "kind TEXT NOT NULL DEFAULT 'user'");
  ensureColumn(db, 'sessions', 'advisor_role', 'advisor_role TEXT');
  ensureColumn(db, 'sessions', 'worktree_path', 'worktree_path TEXT');
  ensureColumn(db, 'sessions', 'wrapper_socket_path', 'wrapper_socket_path TEXT');
  // Sprint L — Agent View bridge.
  ensureColumn(db, 'sessions', 'agent_view_id', 'agent_view_id TEXT');
  ensureColumn(db, 'sessions', 'agent_view_summary', 'agent_view_summary TEXT');
  ensureColumn(db, 'sessions', 'pr_url', 'pr_url TEXT');
  ensureColumn(db, 'sessions', 'pr_check_status', 'pr_check_status TEXT');
  ensureColumn(db, 'advisors', 'texture_pack', 'texture_pack TEXT');
  ensureColumn(db, 'missions', 'error_summary', 'error_summary TEXT');
  // Sprint M — cost tracking, heartbeats, goals.
  ensureColumn(db, 'sessions', 'cost_usd', 'cost_usd REAL DEFAULT 0');
  ensureColumn(db, 'sessions', 'budget_usd', 'budget_usd REAL');
  ensureColumn(db, 'sessions', 'current_goal_id', 'current_goal_id TEXT');
  ensureColumn(db, 'missions', 'goal_id', 'goal_id TEXT');
  ensureColumn(db, 'scheduled_tasks', 'cwd', 'cwd TEXT');
  ensureColumn(db, 'scheduled_tasks', 'name', 'name TEXT');
  // v2 Maestro — plan back-links on dispatched sessions.
  ensureColumn(db, 'sessions', 'plan_id', 'plan_id TEXT');
  ensureColumn(db, 'sessions', 'plan_task_id', 'plan_task_id TEXT');
  ensureColumn(db, 'sessions', 'session_role', 'session_role TEXT');
  // v2 Maestro — durable per-task retry ceiling (idempotent for DBs that
  // created plan_tasks before this column existed).
  ensureColumn(db, 'plan_tasks', 'max_attempts', 'max_attempts INTEGER NOT NULL DEFAULT 3');
  // Last rejection reason, fed back into the next attempt's worker prompt so a
  // retry knows why the previous try was rejected (Phase 3).
  ensureColumn(db, 'plan_tasks', 'last_error', 'last_error TEXT');
  // A completed task's result summary, injected into dependent tasks' prompts.
  ensureColumn(db, 'plan_tasks', 'result_summary', 'result_summary TEXT');
  // Build-studio (Phase 5): user-created projects are durable + owned by Solix,
  // distinct from auto-observed ones; `template` records how to scaffold/preview.
  ensureColumn(db, 'projects', 'managed', 'managed INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'projects', 'template', 'template TEXT');
  // Git baseline captured when a plan starts running — the review surface diffs
  // the working tree against it to show everything the fleet changed.
  ensureColumn(db, 'plans', 'base_ref', 'base_ref TEXT');
  // Indexes on the plan back-link columns — must run AFTER ensureColumn has
  // added the columns to the sessions table (they aren't in the base schema).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_sessions_plan ON sessions(plan_id);
     CREATE INDEX IF NOT EXISTS idx_sessions_plan_task ON sessions(plan_task_id);`,
  );
}

export function getDb(): DB {
  if (_db) return _db;
  ensureSolixHome();
  const db = new Database(DB_PATH);
  applySchema(db);
  _db = db;
  return db;
}

/**
 * Test-only: close any cached connection and open a fresh, fully-migrated DB
 * (default in-memory) so each test runs in isolation. Not used in production.
 */
export function resetDbForTests(path = ':memory:'): DB {
  if (_db) {
    try {
      _db.close();
    } catch {
      /* ignore */
    }
    _db = null;
  }
  const db = new Database(path);
  applySchema(db);
  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
