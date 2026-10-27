import { beforeEach, describe, expect, it } from 'vitest';
import type { HookEvent } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { ensureProject } from './state/projects.js';
import { upsertSession } from './state/sessions.js';
import { listAudit } from './state/audit.js';

/**
 * Integration proof that the containment gate hard-denies an autonomous worker's
 * denylisted tool call — resolving `requestPermission` immediately with no human
 * and no timeout, so full-auto cannot degrade to auto-allow.
 */
function bashEvent(sessionId: string, command: string): HookEvent {
  return {
    event: 'pre_tool_bash',
    pid: 0,
    cwd: '/srv/project',
    ts: Date.now(),
    payload: { session_id: sessionId, tool_name: 'Bash', command },
  } as HookEvent;
}

describe('router containment gate', () => {
  let db: DB;
  let router: EventRouter;
  beforeEach(() => {
    db = resetDbForTests();
    router = new EventRouter(db, new Broadcaster());
  });

  function seedWorker(id: string, role: 'worker' | 'routine' = 'worker'): void {
    const project = ensureProject(db, '/srv/project');
    upsertSession(db, {
      id,
      pid: 0,
      projectId: project.id,
      cwd: '/srv/project',
      origin: 'internal',
      model: 'default',
      kind: 'user',
      sessionRole: role,
    });
  }

  it('hard-denies a worker running a denylisted command (no human, no timeout)', async () => {
    seedWorker('w1');
    const res = await router.requestPermission(bashEvent('w1', 'rm -rf /'));
    expect(res).toEqual({ approved: false, timedOut: false });
    // It never entered the human gate…
    expect(router.pendingPermissions()).toHaveLength(0);
    // …and it was audited as an automatic block, not as a human denial.
    // The distinction is what lets `solix gain` report how much the denylist
    // caught on its own, so filing it as permission_denied would be wrong.
    const blocked = listAudit(db).filter((a) => a.kind === 'command_blocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.summary).toContain('Containment');
    expect(blocked[0]!.payload).toMatchObject({
      tool: 'Bash',
      reason: 'recursive force-delete of a root or home path',
    });
    expect(listAudit(db).some((a) => a.kind === 'permission_denied')).toBe(false);
  });

  /**
   * A worker runs from a plan someone just approved and is watching, so a
   * safe-but-sensitive call is HELD. This asserted auto-allow until 1.14.0,
   * which is how a Maestro worker came to run `rm -rf` on a real machine
   * without anyone being asked.
   */
  it('holds a worker running a sensitive command, for the human who is watching', async () => {
    seedWorker('w2');
    const pending = router.requestPermission(bashEvent('w2', 'npm test'));
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(router.pendingPermissions()).toHaveLength(1);
  });

  /** A routine has nobody at the keyboard, so it proceeds under the denylist. */
  it('auto-allows a ROUTINE running a SAFE command (no human to ask)', async () => {
    seedWorker('r2', 'routine');
    const res = await router.requestPermission(bashEvent('r2', 'npm test'));
    expect(res).toEqual({ approved: true, timedOut: false });
    expect(router.pendingPermissions()).toHaveLength(0); // never entered the gate
  });

  it('still routes a NON-worker session to the human gate', async () => {
    const project = ensureProject(db, '/srv/project');
    upsertSession(db, {
      id: 'u1',
      pid: 0,
      projectId: project.id,
      cwd: '/srv/project',
      origin: 'external',
      model: 'default',
      kind: 'user',
      // no sessionRole → a normal session, human-gated
    });
    const perm = router.requestPermission(bashEvent('u1', 'npm test'));
    await new Promise((r) => setImmediate(r));
    const pendings = router.pendingPermissions();
    expect(pendings).toHaveLength(1);
    router.resolvePermission(pendings[0]!.requestId, false);
    expect((await perm).approved).toBe(false);
  });
});
