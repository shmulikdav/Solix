import { beforeEach, describe, expect, it } from 'vitest';
import type { ScheduledTask, TriggerKind } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';
import { recordAudit } from './state/audit.js';

/**
 * A routine spends real money on a schedule, and nothing checked that the
 * schedule was one Solix could read.
 *
 * cadenceToMs accepts `^(\d+)\s*([mhd])$` and nextRunFrom parks anything
 * else one hour out — described in a comment as a safeguard against
 * busy-firing. For `1w` it is the opposite: the pre-create warning said
 * "every 1w", the card said "every 1w", and the routine fired every hour,
 * forever. 168 times the cost the user agreed to, concealed by the two
 * pieces of UI whose only job was to disclose it. And there is no PATCH for
 * a routine, so it could not be corrected — only deleted, losing its run
 * history and rotating its webhook token.
 */
function makeApp(db: DB) {
  const broadcaster = new Broadcaster();
  const router = new EventRouter(db, broadcaster);
  const orchestrator = new Orchestrator({
    db,
    runner: { runOnce: () => Promise.resolve({ ok: true, output: '{}' }) },
    broadcast: () => {},
    getKnownAdvisorRoles: () => [],
    knownModels: ['default'],
    getMaestroPrompt: () => '',
  });
  return createHttpApp({
    db,
    router,
    orchestrator,
    fireSchedule: (_s: ScheduledTask, _t: TriggerKind) => ({ ok: true as const }),
  });
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('POST /api/schedules cadence validation', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  async function create(cadence: string) {
    const app = makeApp(db);
    return app.request('/api/schedules', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: '/tmp/p', prompt: 'audit deps', cadence }),
    });
  }

  for (const good of ['30m', '2h', '1d', '7d', '90 m']) {
    it(`accepts ${good}`, async () => {
      expect((await create(good)).status).toBe(200);
    });
  }

  /** Every one of these used to become an hourly routine. */
  for (const bad of ['1w', 'weekly', '2 hours', '1 day', 'daily', '0h', 'h']) {
    it(`refuses ${bad} rather than silently firing hourly`, async () => {
      const res = await create(bad);
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain(bad);
    });
  }

  it('says what a cadence may look like, including the week case', async () => {
    const body = (await (await create('1w')).json()) as { error?: string };
    expect(body.error).toMatch(/30m/);
    expect(body.error).toMatch(/7d/);
  });

  it('still allows a webhook routine with no cadence at all', async () => {
    const app = makeApp(db);
    const res = await app.request('/api/schedules', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ cwd: '/tmp/p', prompt: 'deploy', trigger: 'webhook' }),
    });
    expect(res.status).toBe(200);
  });
});

/**
 * Mission Control's Interventions tile fired three unlimited /api/audit
 * requests and summed their `.length`, against a 200-row-per-call cap — so
 * it counted three pages of rows and stopped at 600 forever. The comment
 * above those fetches worried about "quietly shrink[ing] this number for
 * the users with the most to show", which is exactly who it was wrong for.
 */
describe('GET /api/audit/count', () => {
  let db: DB;
  beforeEach(() => {
    db = resetDbForTests();
  });

  it('counts past the row cap that listAudit applies', async () => {
    for (let i = 0; i < 250; i++) {
      recordAudit(db, {
        kind: 'permission_approved',
        sessionId: 's1',
        summary: `approved ${i}`,
      });
    }
    const app = makeApp(db);

    const listed = (await (
      await app.request('/api/audit?kind=permission_approved')
    ).json()) as unknown[];
    expect(listed.length).toBe(200); // the cap that made the tile wrong

    const counted = (await (
      await app.request('/api/audit/count?kind=permission_approved')
    ).json()) as { count: number };
    expect(counted.count).toBe(250);
  });

  it('counts only the kind asked for', async () => {
    recordAudit(db, { kind: 'permission_approved', sessionId: 's1', summary: 'a' });
    recordAudit(db, { kind: 'permission_denied', sessionId: 's1', summary: 'd' });
    const app = makeApp(db);
    const res = (await (
      await app.request('/api/audit/count?kind=permission_denied')
    ).json()) as { count: number };
    expect(res.count).toBe(1);
  });

  it('returns zero rather than failing when there is nothing', async () => {
    const app = makeApp(db);
    const res = (await (
      await app.request('/api/audit/count?kind=command_blocked')
    ).json()) as { count: number };
    expect(res.count).toBe(0);
  });
});
