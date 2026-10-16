import { nanoid } from 'nanoid';
import type { Connection, ConnectionKind } from '@solix/shared';
import type { DB } from '../db.js';
import { now } from '../util.js';
import { decryptSecret, encryptSecret } from '../crypto.js';

/**
 * Scoped connections & secrets. A connection bundles secret key/value pairs (API
 * keys, tokens) stored encrypted at rest (crypto.ts). Grants decide which workers
 * may use it — by advisor role, plan id, or '*'. The decrypted values never leave
 * the server: they're resolved only at worker dispatch and injected into that
 * worker's env (least privilege). The client-facing `Connection` carries key
 * NAMES + grants only, never values.
 */

interface ConnRow {
  id: string;
  name: string;
  kind: string;
  created_at: number;
}

function assemble(db: DB, row: ConnRow): Connection {
  const secretKeys = (
    db
      .prepare('SELECT key FROM secrets WHERE connection_id = ? ORDER BY key')
      .all(row.id) as { key: string }[]
  ).map((r) => r.key);
  const grants = (
    db
      .prepare('SELECT scope FROM connection_grants WHERE connection_id = ? ORDER BY scope')
      .all(row.id) as { scope: string }[]
  ).map((r) => r.scope);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ConnectionKind,
    createdAt: row.created_at,
    secretKeys,
    grants,
  };
}

export function createConnection(
  db: DB,
  input: { name: string; kind: ConnectionKind },
): Connection {
  const id = nanoid(8);
  db.prepare(
    'INSERT INTO connections (id, name, kind, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, input.name, input.kind, now());
  return getConnection(db, id)!;
}

export function getConnection(db: DB, id: string): Connection | null {
  const row = db.prepare('SELECT * FROM connections WHERE id = ?').get(id) as
    | ConnRow
    | undefined;
  return row ? assemble(db, row) : null;
}

export function listConnections(db: DB): Connection[] {
  const rows = db
    .prepare('SELECT * FROM connections ORDER BY created_at DESC')
    .all() as ConnRow[];
  return rows.map((r) => assemble(db, r));
}

export function deleteConnection(db: DB, id: string): boolean {
  db.prepare('DELETE FROM secrets WHERE connection_id = ?').run(id);
  db.prepare('DELETE FROM connection_grants WHERE connection_id = ?').run(id);
  return db.prepare('DELETE FROM connections WHERE id = ?').run(id).changes > 0;
}

/** Store (or rotate) a secret value — encrypted. Values are write-only. */
export function setSecret(
  db: DB,
  connectionId: string,
  key: string,
  value: string,
): void {
  const enc = encryptSecret(value);
  db.prepare(
    `INSERT INTO secrets (id, connection_id, key, value_enc) VALUES (?, ?, ?, ?)
     ON CONFLICT(connection_id, key) DO UPDATE SET value_enc = excluded.value_enc`,
  ).run(nanoid(8), connectionId, key, enc);
}

export function deleteSecret(db: DB, connectionId: string, key: string): void {
  db.prepare('DELETE FROM secrets WHERE connection_id = ? AND key = ?').run(
    connectionId,
    key,
  );
}

export function grantConnection(db: DB, connectionId: string, scope: string): void {
  db.prepare(
    `INSERT INTO connection_grants (connection_id, scope, created_at) VALUES (?, ?, ?)
     ON CONFLICT(connection_id, scope) DO NOTHING`,
  ).run(connectionId, scope, now());
}

export function revokeGrant(db: DB, connectionId: string, scope: string): void {
  db.prepare(
    'DELETE FROM connection_grants WHERE connection_id = ? AND scope = ?',
  ).run(connectionId, scope);
}

/**
 * Resolve the env vars a worker is allowed to see: for every `kind:'env'`
 * connection whose grant matches the worker (its advisor role, its plan id, or
 * '*'), decrypt that connection's secrets into an env map. Default-deny — an
 * ungranted connection contributes nothing. Decryption happens only here, at
 * dispatch; values never touch the API or logs.
 */
export function resolveWorkerEnv(
  db: DB,
  ctx: { advisorRole?: string; planId?: string },
): Record<string, string> {
  const scopes = ['*'];
  if (ctx.advisorRole) scopes.push(ctx.advisorRole);
  if (ctx.planId) scopes.push(ctx.planId);
  const placeholders = scopes.map(() => '?').join(',');
  const connIds = (
    db
      .prepare(
        `SELECT DISTINCT g.connection_id AS id FROM connection_grants g
           JOIN connections c ON c.id = g.connection_id
         WHERE g.scope IN (${placeholders}) AND c.kind = 'env'`,
      )
      .all(...scopes) as { id: string }[]
  ).map((r) => r.id);

  const env: Record<string, string> = {};
  for (const connId of connIds) {
    const secrets = db
      .prepare('SELECT key, value_enc FROM secrets WHERE connection_id = ?')
      .all(connId) as { key: string; value_enc: string }[];
    for (const s of secrets) {
      try {
        env[s.key] = decryptSecret(s.value_enc);
      } catch {
        /* skip a secret that won't decrypt (key rotated/lost) */
      }
    }
  }
  return env;
}
