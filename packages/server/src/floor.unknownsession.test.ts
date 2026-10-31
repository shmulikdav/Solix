import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookEvent, ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { setGovernanceLevel, type GovernanceLevel } from './state/governance.js';
import { listAudit } from './state/audit.js';

/**
 * The command denylist is a floor. A floor with a database lookup in front
 * of it is not a floor.
 *
 * `evaluateContainment` used to be called only inside `if (session)`, so a
 * tool call whose session row could not be found skipped it entirely and
 * fell through to the dial. Probed against a running server before this was
 * written: `sudo -n true` under a session id the server had never seen came
 * back `{"decision":"allow"}` at `observe`, and was merely *held for a
 * human* at `standard` and `strict` — with zero `command_blocked` rows at
 * any level.
 *
 * A session row is absent for ordinary reasons: a tool hook arriving before
 * `session-start` has been processed, a pre-created planet row that failed
 * to write, a correlation miss. None of them should decide whether
 * `rm -rf /` runs.
 */
function bashEvent(sessionId: string, command: string): HookEvent {
  return {
    event: 'pre_tool_bash',
    pid: 4242,
    cwd: '/tmp/nowhere',
    ts: Date.now(),
    payload: { session_id: sessionId, tool_name: 'Bash', tool_input: { command } },
  } as HookEvent;
}

const LEVELS: GovernanceLevel[] = ['observe', 'standard', 'strict'];

describe('CLAIM-FLOOR-NO-SESSION · the floor and an unknown session', () => {
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
    // Deliberately seed nothing: the session id below has no row.
  });

  it.each(LEVELS)('refuses a denylisted command at %s', async (level) => {
    setGovernanceLevel(db, level);
    await expect(
      router.requestPermission(bashEvent('ghost', 'sudo -n true')),
    ).resolves.toEqual({ approved: false, timedOut: false });
  });

  it.each(LEVELS)('records why, at %s', async (level) => {
    setGovernanceLevel(db, level);
    await router.requestPermission(bashEvent('ghost', 'rm -rf /'));

    const blocked = listAudit(db, { kind: 'command_blocked' });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.summary).toMatch(/containment blocked/i);
  });

  /** It must be refused outright, not turned into a card someone can wave through. */
  it('does not raise a decision card for it', async () => {
    setGovernanceLevel(db, 'standard');
    await router.requestPermission(bashEvent('ghost', 'sudo -n true'));
    expect(sent.filter((m) => m.type === 'permission_request')).toHaveLength(0);
  });

  /**
   * The floor is the denylist, not everything. An unknown session running an
   * ordinary command still goes to the dial — at `standard` that means a
   * human sees it, which is the existing behaviour and should stay.
   */
  it('still holds an ordinary sensitive command for a human', async () => {
    setGovernanceLevel(db, 'standard');
    void router.requestPermission(bashEvent('ghost', 'git push --force'));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.filter((m) => m.type === 'permission_request')).toHaveLength(1);
  });

  it('leaves a harmless command alone', async () => {
    setGovernanceLevel(db, 'observe');
    await expect(
      router.requestPermission(bashEvent('ghost', 'ls -la')),
    ).resolves.toEqual({ approved: true, timedOut: false });
  });
});
