import { beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { resetDbForTests, type DB } from '../db.js';
import { decryptSecret, encryptSecret } from '../crypto.js';
import {
  createConnection,
  deleteConnection,
  grantConnection,
  listConnections,
  resolveWorkerEnv,
  revokeGrant,
  setSecret,
} from './connections.js';

describe('crypto (AES-256-GCM)', () => {
  const key = randomBytes(32);
  it('round-trips a secret', () => {
    const packed = encryptSecret('ghp_supersecret', key);
    expect(packed).not.toContain('ghp_supersecret'); // stored ciphertext, not plaintext
    expect(decryptSecret(packed, key)).toBe('ghp_supersecret');
  });
  it('fails to decrypt a tampered ciphertext', () => {
    const packed = encryptSecret('v', key);
    const [iv, tag, ct] = packed.split(':');
    const flipped = `${iv}:${tag}:${Buffer.from('zzzz').toString('base64')}${ct}`;
    expect(() => decryptSecret(flipped, key)).toThrow();
  });
  it('fails to decrypt with the wrong key', () => {
    const packed = encryptSecret('v', key);
    expect(() => decryptSecret(packed, randomBytes(32))).toThrow();
  });
});

describe('connections store', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('creates a connection and stores secret KEYS (never values)', () => {
    const c = createConnection(db, { name: 'GitHub', kind: 'env' });
    setSecret(db, c.id, 'GITHUB_TOKEN', 'ghp_abc');
    const listed = listConnections(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.secretKeys).toEqual(['GITHUB_TOKEN']);
    // The value is nowhere in the client-facing shape.
    expect(JSON.stringify(listed)).not.toContain('ghp_abc');
  });

  it('resolveWorkerEnv is default-deny and respects grants', () => {
    const c = createConnection(db, { name: 'GitHub', kind: 'env' });
    setSecret(db, c.id, 'GITHUB_TOKEN', 'ghp_abc');

    // No grant → no worker sees it.
    expect(resolveWorkerEnv(db, { advisorRole: 'forge', planId: 'p1' })).toEqual({});

    // Grant to a specific advisor role.
    grantConnection(db, c.id, 'forge');
    expect(resolveWorkerEnv(db, { advisorRole: 'forge' })).toEqual({
      GITHUB_TOKEN: 'ghp_abc',
    });
    // A different role still gets nothing.
    expect(resolveWorkerEnv(db, { advisorRole: 'argus' })).toEqual({});

    // '*' grants every worker.
    revokeGrant(db, c.id, 'forge');
    grantConnection(db, c.id, '*');
    expect(resolveWorkerEnv(db, { advisorRole: 'argus' })).toEqual({
      GITHUB_TOKEN: 'ghp_abc',
    });
  });

  it('matches a plan-scoped grant', () => {
    const c = createConnection(db, { name: 'Deploy', kind: 'env' });
    setSecret(db, c.id, 'RAILWAY_TOKEN', 'rw_1');
    grantConnection(db, c.id, 'plan-123');
    expect(resolveWorkerEnv(db, { planId: 'plan-123' })).toEqual({
      RAILWAY_TOKEN: 'rw_1',
    });
    expect(resolveWorkerEnv(db, { planId: 'plan-999' })).toEqual({});
  });

  it('ignores non-env connection kinds for env resolution', () => {
    const c = createConnection(db, { name: 'MCP server', kind: 'mcp' });
    setSecret(db, c.id, 'X', 'y');
    grantConnection(db, c.id, '*');
    expect(resolveWorkerEnv(db, { advisorRole: 'forge' })).toEqual({});
  });

  it('deletes a connection and its secrets/grants', () => {
    const c = createConnection(db, { name: 'Tmp', kind: 'env' });
    setSecret(db, c.id, 'K', 'v');
    grantConnection(db, c.id, '*');
    expect(deleteConnection(db, c.id)).toBe(true);
    expect(listConnections(db)).toHaveLength(0);
    expect(resolveWorkerEnv(db, { advisorRole: 'forge' })).toEqual({});
  });
});
