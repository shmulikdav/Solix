import { beforeEach, describe, expect, it } from 'vitest';
import type { HookEvent } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { ensureProject } from './state/projects.js';
import { upsertSession } from './state/sessions.js';
import {
  getGovernanceLevel,
  setGovernanceLevel,
  type GovernanceLevel,
} from './state/governance.js';
import { listAudit } from './state/audit.js';

/**
 * The dial decides what is held for a human. It must never decide what is
 * allowed to run unchecked — the denylist sits underneath all three levels,
 * including `observe`. That property is the point of these tests.
 */
function bashEvent(sessionId: string, command: string): HookEvent {
  return {
    event: 'pre_tool_bash',
    pid: 1234,
    cwd: '/tmp/gov',
    ts: Date.now(),
    payload: { session_id: sessionId, tool_name: 'Bash', tool_input: { command } },
  } as HookEvent;
}

describe('CLAIM-FLOOR-ALL-LEVELS · governance level', () => {
  let db: DB;
  let router: EventRouter;

  beforeEach(() => {
    db = resetDbForTests();
    router = new EventRouter(db, new Broadcaster());
  });

  function seed(id: string, role?: 'worker' | 'verifier' | 'routine'): void {
    const project = ensureProject(db, '/tmp/gov');
    upsertSession(db, {
      id,
      pid: 1234,
      projectId: project.id,
      cwd: '/tmp/gov',
      origin: role ? 'internal' : 'external',
      ...(role ? { sessionRole: role } : {}),
    });
  }

  it('defaults to standard', () => {
    expect(getGovernanceLevel(db)).toBe('standard');
  });

  it('rejects a level it does not know, keeping the current one', () => {
    setGovernanceLevel(db, 'strict');
    // The setter is typed, so the guard that matters is the HTTP one; this
    // pins that a junk value already stored reads back as the default rather
    // than being honoured.
    db.prepare(
      `INSERT INTO app_settings (key, value) VALUES ('governance.level', 'yolo')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run();
    expect(getGovernanceLevel(db)).toBe('standard');
  });

  describe('standard (the default)', () => {
    it('holds a sensitive call from a launched task', async () => {
      seed('s1');
      const pending = router.requestPermission(bashEvent('s1', 'git push'));
      // Still waiting — nothing resolved it.
      let settled = false;
      void pending.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).toBe(false);
      expect(router.pendingPermissions()).toHaveLength(1);
    });

    /**
     * This asserted the opposite until 1.14.0, and the opposite is what
     * shipped: a Maestro worker ran `rm -rf` on a real machine and nobody was
     * asked, while the product's front page promised the command would be
     * held. The level's own description always said it would be. This is the
     * contract, now enforced.
     */
    it('HOLDS a worker — a plan you are watching is the whole promise', async () => {
      seed('w1', 'worker');
      const pending = router.requestPermission(bashEvent('w1', 'rm -rf ./canary'));
      let settled = false;
      void pending.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 50));

      expect(settled).toBe(false);
      expect(router.pendingPermissions()).toHaveLength(1);

      // And a denial really denies.
      const [req] = router.pendingPermissions();
      router.resolvePermission(req!.requestId, false);
      await expect(pending).resolves.toEqual({ approved: false, timedOut: false });
    });

    it('holds a verifier too', async () => {
      seed('v1', 'verifier');
      const pending = router.requestPermission(bashEvent('v1', 'rm -rf ./build'));
      let settled = false;
      void pending.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 50));
      expect(settled).toBe(false);
      expect(router.pendingPermissions()).toHaveLength(1);
    });

    /**
     * The exception, and the reason this is not simply "hold everything":
     * a routine fires on a schedule with nobody at the keyboard. Holding one
     * would stall until the gate timed out and then deny, turning every
     * unattended run into a silent failure. The denylist is its boundary.
     */
    it('auto-allows a ROUTINE, which fires with nobody watching', async () => {
      seed('r1', 'routine');
      await expect(router.requestPermission(bashEvent('r1', 'ls'))).resolves.toEqual({
        approved: true,
        timedOut: false,
      });
      expect(router.pendingPermissions()).toHaveLength(0);
    });
  });

  describe('observe', () => {
    it('holds nothing', async () => {
      setGovernanceLevel(db, 'observe');
      seed('s1');
      await expect(
        router.requestPermission(bashEvent('s1', 'git push')),
      ).resolves.toEqual({ approved: true, timedOut: false });
      expect(router.pendingPermissions()).toHaveLength(0);
    });

    /** The property the whole design rests on. */
    it('STILL blocks a denylisted command', async () => {
      setGovernanceLevel(db, 'observe');
      seed('w1', 'worker');

      await expect(
        router.requestPermission(bashEvent('w1', 'rm -rf /')),
      ).resolves.toEqual({ approved: false, timedOut: false });

      expect(
        listAudit(db).some((a) => a.kind === 'command_blocked'),
      ).toBe(true);
    });
  });

  describe('strict', () => {
    it('holds a ROUTINE, which standard auto-allows', async () => {
      setGovernanceLevel(db, 'strict');
      seed('w1', 'routine');

      const pending = router.requestPermission(bashEvent('w1', 'ls'));
      let settled = false;
      void pending.then(() => (settled = true));
      await new Promise((r) => setTimeout(r, 50));

      expect(settled).toBe(false);
      expect(router.pendingPermissions()).toHaveLength(1);

      // And it resolves the ordinary way.
      const [req] = router.pendingPermissions();
      router.resolvePermission(req!.requestId, true);
      await expect(pending).resolves.toEqual({ approved: true, timedOut: false });
    });

    it('still refuses a denylisted command without asking', async () => {
      setGovernanceLevel(db, 'strict');
      seed('w1', 'worker');
      await expect(
        router.requestPermission(bashEvent('w1', 'sudo rm -rf /')),
      ).resolves.toEqual({ approved: false, timedOut: false });
      expect(router.pendingPermissions()).toHaveLength(0);
    });
  });

  it('takes effect on the next call, without a restart', async () => {
    seed('s1');
    setGovernanceLevel(db, 'observe');
    await expect(router.requestPermission(bashEvent('s1', 'ls'))).resolves.toEqual({
      approved: true,
      timedOut: false,
    });

    setGovernanceLevel(db, 'standard');
    const pending = router.requestPermission(bashEvent('s1', 'git push'));
    let settled = false;
    void pending.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
  });

  it.each(['observe', 'standard', 'strict'] as GovernanceLevel[])(
    'never lets a fork bomb through at %s',
    async (lvl) => {
      setGovernanceLevel(db, lvl);
      seed('w1', 'worker');
      await expect(
        router.requestPermission(bashEvent('w1', ':(){ :|:& };:')),
      ).resolves.toEqual({ approved: false, timedOut: false });
    },
  );
});
