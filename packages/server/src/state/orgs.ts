import { nanoid } from 'nanoid';
import type { Org, StorageStatus } from '@solix/shared';
import type { DB } from '../db.js';
import { now } from '../util.js';

// ── Multi-org tenancy (P3 #10) ─────────────────────────────────────────
// A default org always exists; a Team edition adds more to isolate plans and
// goals. The "current org" (what new plans/goals are stamped with, and what the
// UI shows) lives in app_settings.

export const DEFAULT_ORG_ID = 'org-default';
const CURRENT_ORG_KEY = 'current_org_id';

interface OrgRow {
  id: string;
  name: string;
  created_at: number;
}

function rowToOrg(row: OrgRow): Org {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

/** Ensure the default org exists; returns it. Idempotent (safe to call at boot). */
export function ensureDefaultOrg(db: DB): Org {
  const existing = db
    .prepare('SELECT * FROM orgs WHERE id = ?')
    .get(DEFAULT_ORG_ID) as OrgRow | undefined;
  if (existing) return rowToOrg(existing);
  db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(
    DEFAULT_ORG_ID,
    'Personal',
    now(),
  );
  return getOrg(db, DEFAULT_ORG_ID)!;
}

export function createOrg(db: DB, name: string): Org {
  ensureDefaultOrg(db);
  const id = `org-${nanoid(8)}`;
  db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)').run(
    id,
    name.trim() || 'Untitled org',
    now(),
  );
  return getOrg(db, id)!;
}

export function getOrg(db: DB, id: string): Org | null {
  const row = db.prepare('SELECT * FROM orgs WHERE id = ?').get(id) as
    | OrgRow
    | undefined;
  return row ? rowToOrg(row) : null;
}

export function listOrgs(db: DB): Org[] {
  ensureDefaultOrg(db);
  const rows = db
    .prepare('SELECT * FROM orgs ORDER BY created_at ASC')
    .all() as OrgRow[];
  return rows.map(rowToOrg);
}

export function renameOrg(db: DB, id: string, name: string): Org | null {
  db.prepare('UPDATE orgs SET name = ? WHERE id = ?').run(name.trim(), id);
  return getOrg(db, id);
}

/**
 * Delete an org. Refuses the default org and the last remaining org. Its plans
 * and goals are reassigned to the default org (never orphaned).
 */
export function deleteOrg(db: DB, id: string): { ok: boolean; error?: string } {
  if (id === DEFAULT_ORG_ID) return { ok: false, error: 'the default org cannot be deleted' };
  if (!getOrg(db, id)) return { ok: false, error: 'not found' };
  db.prepare('UPDATE plans SET org_id = ? WHERE org_id = ?').run(DEFAULT_ORG_ID, id);
  db.prepare('UPDATE goals SET org_id = ? WHERE org_id = ?').run(DEFAULT_ORG_ID, id);
  db.prepare('DELETE FROM orgs WHERE id = ?').run(id);
  // If the deleted org was current, fall back to default.
  if (getCurrentOrgId(db) === id) setCurrentOrgId(db, DEFAULT_ORG_ID);
  return { ok: true };
}

// ── app_settings (tiny kv) ─────────────────────────────────────────────

export function getSetting(db: DB, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

/** The org new plans/goals are stamped with + the UI shows. Defaults to the
 *  default org (self-healing if the stored current org was deleted). */
export function getCurrentOrgId(db: DB): string {
  const stored = getSetting(db, CURRENT_ORG_KEY);
  if (stored && getOrg(db, stored)) return stored;
  ensureDefaultOrg(db);
  return DEFAULT_ORG_ID;
}

export function setCurrentOrgId(db: DB, id: string): boolean {
  if (!getOrg(db, id)) return false;
  setSetting(db, CURRENT_ORG_KEY, id);
  return true;
}

// ── Storage backend seam (P3 #10) ──────────────────────────────────────
// SQLite is the implemented driver. Postgres/S3 are config-gated adapters: the
// env below declares intent, and this status surfaces it honestly rather than
// pretending a backend swap that isn't wired yet.

export function describeStorage(): StorageStatus {
  const postgresConfigured = Boolean(process.env.SOLIX_PG_URL);
  const s3Configured = Boolean(process.env.SOLIX_S3_BUCKET);
  const note =
    postgresConfigured || s3Configured
      ? 'A Team-edition backend is configured, but SQLite is still the active driver — the Postgres/S3 adapters are not wired in this build.'
      : 'Local SQLite (single-node, zero-telemetry). Set SOLIX_PG_URL / SOLIX_S3_BUCKET to target a Team-edition backend when its adapters ship.';
  return { active: 'sqlite', postgresConfigured, s3Configured, note };
}
