import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HookEvent, ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { ensureProject } from './state/projects.js';
import { getSession, upsertSession } from './state/sessions.js';
import { listAudit } from './state/audit.js';

/**
 * A held command is the product. Whether the hold was released, and why, was
 * the one thing the protocol could not say.
 *
 * `permission_resolved` did not exist. The client deleted its decision card
 * the moment it sent `permission_response` over a fire-and-forget socket, so
 * a response dropped by a reconnecting socket was indistinguishable from a
 * successful one — card gone, badge cleared, agent blocked forever on a
 * decision the user believed they had made. A second tab kept a live card
 * with buttons behind it. And the 300-second timeout denied in total
 * silence: no audit row, no toast, the card still on screen and still
 * counted.
 *
 * These tests pin the announcement, not the decision.
 */
function bashEvent(sessionId: string, command: string): HookEvent {
  return {
    event: 'pre_tool_bash',
    pid: 4242,
    cwd: '/tmp/ack',
    ts: Date.now(),
    payload: { session_id: sessionId, tool_name: 'Bash', tool_input: { command } },
  } as HookEvent;
}

describe('a resolved permission is announced', () => {
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
    const project = ensureProject(db, '/tmp/ack');
    upsertSession(db, {
      id: 's1',
      pid: 4242,
      projectId: project.id,
      cwd: '/tmp/ack',
      origin: 'external',
    });
  });

  function resolved() {
    return sent.filter((m) => m.type === 'permission_resolved');
  }

  function requestId(): string {
    const req = sent.find((m) => m.type === 'permission_request');
    if (req?.type !== 'permission_request') throw new Error('no request sent');
    return req.requestId;
  }

  it('announces an approval, with the request it belongs to', async () => {
    const pending = router.requestPermission(bashEvent('s1', 'git push'));
    const id = requestId();

    router.resolvePermission(id, true);
    await expect(pending).resolves.toEqual({ approved: true, timedOut: false });

    expect(resolved()).toEqual([
      {
        type: 'permission_resolved',
        requestId: id,
        sessionId: 's1',
        outcome: 'approved',
      },
    ]);
  });

  it('announces a denial', async () => {
    const pending = router.requestPermission(bashEvent('s1', 'rm -rf /'));
    const id = requestId();

    router.resolvePermission(id, false);
    await expect(pending).resolves.toEqual({ approved: false, timedOut: false });

    expect(resolved()[0]).toMatchObject({ requestId: id, outcome: 'denied' });
  });

  /**
   * The case that was fully silent. Five minutes after walking away the agent
   * has been refused; this is the only thing that can say so.
   */
  describe('the gate timeout', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it('announces the denial instead of expiring quietly', async () => {
      vi.stubEnv('SOLIX_GATE_TIMEOUT_MS', '1000');
      const pending = router.requestPermission(bashEvent('s1', 'git push'));
      requestId();

      expect(resolved()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1100);
      await expect(pending).resolves.toEqual({ approved: false, timedOut: true });

      expect(resolved()[0]).toMatchObject({ outcome: 'timed_out' });
      vi.unstubAllEnvs();
    });

    it('says in the toast that the agent was refused, not still waiting', async () => {
      vi.stubEnv('SOLIX_GATE_TIMEOUT_MS', '1000');
      const pending = router.requestPermission(bashEvent('s1', 'git push'));
      await vi.advanceTimersByTimeAsync(1100);
      await pending;

      const toast = sent.find(
        (m) => m.type === 'toast' && m.level === 'error',
      );
      expect(toast?.type === 'toast' && toast.message).toMatch(/denied/i);
      vi.unstubAllEnvs();
    });

    /** No audit row meant the ledger disagreed with what happened. */
    it('records the denial in the audit log', async () => {
      vi.stubEnv('SOLIX_GATE_TIMEOUT_MS', '1000');
      const pending = router.requestPermission(bashEvent('s1', 'git push'));
      await vi.advanceTimersByTimeAsync(1100);
      await pending;

      const denials = listAudit(db, { kind: 'permission_denied' });
      expect(denials).toHaveLength(1);
      expect(denials[0]?.summary).toMatch(/timed out/i);
      vi.unstubAllEnvs();
    });
  });

  it('says nothing for a request that was already resolved', () => {
    const pending = router.requestPermission(bashEvent('s1', 'git push'));
    const id = requestId();
    router.resolvePermission(id, true);
    void pending;

    sent.length = 0;
    expect(router.resolvePermission(id, true)).toBe(false);
    expect(resolved()).toHaveLength(0);
  });
});

/**
 * `terminate_session` was a bare `break` in the websocket handler, under a
 * comment claiming it marked the row terminated. It did not do even that: the
 * danger-red Terminate button — on a list with select-all — cleared the
 * selection and left every process running, with no toast and no error.
 */
describe('terminateSession', () => {
  let db: DB;
  let router: EventRouter;

  beforeEach(() => {
    db = resetDbForTests();
    router = new EventRouter(db, new Broadcaster());
    const project = ensureProject(db, '/tmp/ack');
    upsertSession(db, {
      id: 's1',
      pid: 4242,
      projectId: project.id,
      cwd: '/tmp/ack',
      origin: 'external',
    });
  });

  it('marks the session terminated', () => {
    const res = router.terminateSession('s1');
    expect(res.ok).toBe(true);
    expect(getSession(db, 's1')?.status).toBe('terminated');
  });

  /**
   * Solix did not start an external session, so it cannot stop it. Saying so
   * is the honest outcome; silently clearing the planet while the process
   * keeps spending is not.
   */
  it('does not claim to have killed a process it never started', () => {
    const res = router.terminateSession('s1');
    expect(res.killed).toBe(false);
    expect(res.detail).toMatch(/still running|terminal|cleared/i);
  });

  it('reports a session it does not know', () => {
    expect(router.terminateSession('nope').ok).toBe(false);
  });

  it('is idempotent', () => {
    router.terminateSession('s1');
    const again = router.terminateSession('s1');
    expect(again.ok).toBe(true);
    expect(again.detail).toMatch(/already/i);
  });
});
