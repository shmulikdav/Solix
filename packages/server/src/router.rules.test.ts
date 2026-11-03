import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookEvent, ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { ensureProject } from './state/projects.js';
import { upsertSession } from './state/sessions.js';
import { listAudit } from './state/audit.js';
import { countLedgerDecisions, countRuleDecisions } from './state/ledger.js';
import { createRule, installDefaultRules } from './state/rules.js';
import { setGovernanceLevel } from './state/governance.js';

/**
 * Approval rules at the gate, run through the real router with the real
 * floor in front of them. Measured on 1.18.3: a five-task plan was held
 * thirty times for thirty tool calls, `Read SPEC.md` included. A rule is a
 * person's standing answer, and these pin the two things it must never
 * become: a way past the floor, and a person in the ledger.
 */
const CWD = '/tmp/rules-project';

function event(sessionId: string, tool: 'Bash' | 'Read' | 'Write', input: Record<string, unknown>): HookEvent {
  return {
    event: tool === 'Bash' ? 'pre_tool_bash' : 'pre_tool_file',
    pid: 4242,
    cwd: CWD,
    ts: Date.now(),
    payload: { session_id: sessionId, tool_name: tool, tool_input: input },
  } as HookEvent;
}

describe('approval rules at the gate', () => {
  let db: DB;
  let router: EventRouter;
  let sent: ServerMessage[];
  let projectId: string;

  beforeEach(() => {
    db = resetDbForTests();
    const broadcaster = new Broadcaster();
    sent = [];
    vi.spyOn(broadcaster, 'broadcast').mockImplementation((m: ServerMessage) => {
      sent.push(m);
    });
    router = new EventRouter(db, broadcaster);
    setGovernanceLevel(db, 'standard');
    projectId = ensureProject(db, CWD).id;
    upsertSession(db, {
      id: 'w1',
      pid: 4242,
      projectId,
      cwd: CWD,
      origin: 'internal',
      sessionRole: 'worker',
    });
  });

  const holds = () => sent.filter((m) => m.type === 'permission_request');
  const kinds = () => listAudit(db, { limit: 50 }).map((e) => e.kind);

  it('with no rules, a worker Read is held for a person (the 1.18.3 behaviour)', async () => {
    const p = router.requestPermission(event('w1', 'Read', { file_path: `${CWD}/SPEC.md` }));
    expect(holds()).toHaveLength(1);
    router.resolvePermission(holds()[0]!.requestId, false);
    await expect(p).resolves.toMatchObject({ approved: false });
  });

  it('with the defaults installed, the same Read is allowed by a rule and nobody is asked', async () => {
    installDefaultRules(db, projectId);
    const result = await router.requestPermission(event('w1', 'Read', { file_path: `${CWD}/SPEC.md` }));
    expect(result).toMatchObject({ approved: true, timedOut: false });
    expect(holds()).toHaveLength(0);
    expect(kinds()).toContain('permission_auto_approved');
    expect(kinds()).not.toContain('permission_approved');
  });

  it('a command the defaults do not cover is still held', async () => {
    installDefaultRules(db, projectId);
    const p = router.requestPermission(event('w1', 'Bash', { command: 'git rm -r canary' }));
    expect(holds()).toHaveLength(1);
    router.resolvePermission(holds()[0]!.requestId, false);
    await p;
  });

  it('a deny rule refuses with a reason that names a standing decision', async () => {
    createRule(db, {
      scope: 'project',
      projectId,
      tool: 'Bash',
      match: 'command_prefix',
      value: 'git push',
      decision: 'deny',
    });
    const result = await router.requestPermission(event('w1', 'Bash', { command: 'git push origin main' }));
    expect(result.approved).toBe(false);
    expect(result.reason).toMatch(/standing decision/);
    expect(holds()).toHaveLength(0);
    expect(kinds()).toContain('permission_auto_denied');
  });

  it('a session Solix does not know gets no rule — it is held as before', async () => {
    installDefaultRules(db);
    const p = router.requestPermission(event('ghost', 'Read', { file_path: `${CWD}/SPEC.md` }));
    expect(holds()).toHaveLength(1);
    router.resolvePermission(holds()[0]!.requestId, false);
    await p;
  });
});

describe('CLAIM-RULES-NEVER-OVERRIDE-FLOOR — a rule cannot let a denylisted command through', () => {
  let db: DB;
  let router: EventRouter;
  let sent: ServerMessage[];

  beforeEach(() => {
    db = resetDbForTests();
    const broadcaster = new Broadcaster();
    sent = [];
    vi.spyOn(broadcaster, 'broadcast').mockImplementation((m: ServerMessage) => {
      sent.push(m);
    });
    router = new EventRouter(db, broadcaster);
    setGovernanceLevel(db, 'observe');
    const projectId = ensureProject(db, CWD).id;
    upsertSession(db, { id: 'w1', pid: 1, projectId, cwd: CWD, origin: 'internal', sessionRole: 'worker' });
    // The broadest allow a person could write.
    createRule(db, { scope: 'global', tool: '*', match: 'command_regex', value: '.*', decision: 'allow' });
  });

  it('the floor runs first and the rule is never consulted', async () => {
    const result = await router.requestPermission(event('w1', 'Bash', { command: 'rm -rf /' }));
    expect(result.approved).toBe(false);
    const kinds = listAudit(db, { limit: 10 }).map((e) => e.kind);
    expect(kinds).toContain('command_blocked');
    expect(kinds).not.toContain('permission_auto_approved');
    expect(sent.filter((m) => m.type === 'permission_request')).toHaveLength(0);
  });

  it('and an allow rule still lets an ordinary command through at the same level', async () => {
    const result = await router.requestPermission(event('w1', 'Bash', { command: 'ls -la' }));
    expect(result.approved).toBe(true);
  });
});

describe('CLAIM-AUTO-DECISIONS-LABELLED — a rule is never counted as a person', () => {
  it('rule decisions sit outside the ledger count and inside their own', async () => {
    const db = resetDbForTests();
    const broadcaster = new Broadcaster();
    const sent: ServerMessage[] = [];
    vi.spyOn(broadcaster, 'broadcast').mockImplementation((m: ServerMessage) => {
      sent.push(m);
    });
    const router = new EventRouter(db, broadcaster);
    setGovernanceLevel(db, 'standard');
    const projectId = ensureProject(db, CWD).id;
    upsertSession(db, { id: 'w1', pid: 1, projectId, cwd: CWD, origin: 'internal', sessionRole: 'worker' });
    installDefaultRules(db, projectId);

    // Three calls a rule decides, one a person decides.
    for (const f of ['a', 'b', 'c']) {
      await router.requestPermission(event('w1', 'Read', { file_path: `${CWD}/${f}` }));
    }
    const p = router.requestPermission(event('w1', 'Bash', { command: 'git rm -r canary' }));
    const hold = sent.find((m) => m.type === 'permission_request')!;
    router.resolvePermission(hold.requestId, true);
    await p;

    expect(countRuleDecisions(db)).toBe(3);
    expect(countLedgerDecisions(db)).toBe(1);
  });
});

/**
 * CLAIM-RULES-SEE-EVERY-PATH, through the router: a relative path resolves
 * from the directory the call runs in, which Claude Code reports as `cwd` in
 * the hook input. From `packages/cli`, `../server/x` is inside the project;
 * from the root it is not.
 */
describe('the call directory reaches the rules', () => {
  it('resolves ../ from the call’s cwd, not the project root', async () => {
    const db = resetDbForTests();
    const broadcaster = new Broadcaster();
    const sent: ServerMessage[] = [];
    vi.spyOn(broadcaster, 'broadcast').mockImplementation((m: ServerMessage) => void sent.push(m));
    const router = new EventRouter(db, broadcaster);
    setGovernanceLevel(db, 'standard');
    const projectId = ensureProject(db, CWD).id;
    upsertSession(db, { id: 'w1', pid: 4242, projectId, cwd: CWD, origin: 'internal', sessionRole: 'worker' });
    installDefaultRules(db, projectId);

    const ev = (cwd?: string) =>
      ({
        event: 'pre_tool_bash',
        pid: 4242,
        cwd: CWD,
        ts: Date.now(),
        payload: { session_id: 'w1', tool_name: 'Bash', tool_input: { command: 'cat ../server/src/a.ts' }, ...(cwd ? { cwd } : {}) },
      }) as HookEvent;

    await expect(router.requestPermission(ev(`${CWD}/packages/cli`))).resolves.toMatchObject({ approved: true });
    expect(sent.filter((m) => m.type === 'permission_request')).toHaveLength(0);

    const held = router.requestPermission(ev());
    const req = sent.filter((m) => m.type === 'permission_request');
    expect(req).toHaveLength(1);
    router.resolvePermission((req[0] as { requestId: string }).requestId, false);
    await held;
  });
});
