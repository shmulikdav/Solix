import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetDbForTests, type DB } from '../db.js';
import { createPlan, listPlansForOrg } from './plans.js';
import { createGoal, listGoalsForOrg } from './goals.js';
import {
  DEFAULT_ORG_ID,
  createOrg,
  deleteOrg,
  describeStorage,
  ensureDefaultOrg,
  getCurrentOrgId,
  listOrgs,
  renameOrg,
  setCurrentOrgId,
} from './orgs.js';

describe('multi-org tenancy (P3 #10)', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('seeds a default org idempotently', () => {
    const a = ensureDefaultOrg(db);
    const b = ensureDefaultOrg(db);
    expect(a.id).toBe(DEFAULT_ORG_ID);
    expect(b.id).toBe(DEFAULT_ORG_ID);
    expect(listOrgs(db)).toHaveLength(1);
  });

  it('defaults the current org to the default and switches', () => {
    expect(getCurrentOrgId(db)).toBe(DEFAULT_ORG_ID);
    const org = createOrg(db, 'Acme');
    expect(setCurrentOrgId(db, org.id)).toBe(true);
    expect(getCurrentOrgId(db)).toBe(org.id);
    // Switching to an unknown org is refused.
    expect(setCurrentOrgId(db, 'nope')).toBe(false);
  });

  it('stamps new plans + goals with the current org and scopes listing', () => {
    const acme = createOrg(db, 'Acme');
    // Created while default is current → default org.
    const p1 = createPlan(db, { name: 'P1', goalPrompt: 'g', cwd: '/tmp/a' });
    expect(p1.orgId).toBe(DEFAULT_ORG_ID);
    // Switch, then create → Acme.
    setCurrentOrgId(db, acme.id);
    const p2 = createPlan(db, { name: 'P2', goalPrompt: 'g', cwd: '/tmp/b' });
    const g2 = createGoal(db, { name: 'G2' });
    expect(p2.orgId).toBe(acme.id);
    expect(g2.orgId).toBe(acme.id);

    expect(listPlansForOrg(db, DEFAULT_ORG_ID).map((p) => p.name)).toEqual(['P1']);
    expect(listPlansForOrg(db, acme.id).map((p) => p.name)).toEqual(['P2']);
    expect(listGoalsForOrg(db, acme.id).map((g) => g.name)).toEqual(['G2']);
  });

  it('treats a NULL org_id plan as the default org', () => {
    const p = createPlan(db, { name: 'Legacy', goalPrompt: 'g', cwd: '/tmp/x' });
    db.prepare('UPDATE plans SET org_id = NULL WHERE id = ?').run(p.id);
    expect(listPlansForOrg(db, DEFAULT_ORG_ID).map((x) => x.name)).toContain('Legacy');
  });

  it('deletes an org, reassigns its plans to default, and guards the default', () => {
    const acme = createOrg(db, 'Acme');
    setCurrentOrgId(db, acme.id);
    createPlan(db, { name: 'P', goalPrompt: 'g', cwd: '/tmp/a' });
    // Can't delete the default org.
    expect(deleteOrg(db, DEFAULT_ORG_ID).ok).toBe(false);
    // Delete Acme → its plan moves to default, current falls back.
    expect(deleteOrg(db, acme.id).ok).toBe(true);
    expect(getCurrentOrgId(db)).toBe(DEFAULT_ORG_ID);
    expect(listPlansForOrg(db, DEFAULT_ORG_ID).map((p) => p.name)).toContain('P');
    expect(deleteOrg(db, 'nope').error).toBe('not found');
  });

  it('renames an org', () => {
    const acme = createOrg(db, 'Acme');
    expect(renameOrg(db, acme.id, 'Globex')!.name).toBe('Globex');
  });

  it('describeStorage reports sqlite + config flags', () => {
    const base = describeStorage();
    expect(base.active).toBe('sqlite');
    expect(base.postgresConfigured).toBe(false);
    process.env.SOLIX_PG_URL = 'postgres://x';
    expect(describeStorage().postgresConfigured).toBe(true);
    delete process.env.SOLIX_PG_URL;
  });
});
