import { beforeEach, describe, expect, it } from 'vitest';
import { useSolixStore } from './index.js';
import type { PendingPermission } from './index.js';

/**
 * `ws/client.ts` sent like this:
 *
 *     if (socket && socket.readyState === WebSocket.OPEN) {
 *       socket.send(JSON.stringify(msg));
 *     }
 *
 * No else, no queue, no return value — so every caller assumed success. The
 * socket drops on any server restart, which is every upgrade, and for the
 * ~1.5s until it reconnects ten user actions were discarded in silence.
 *
 * Three of them actively lied about it:
 *   - an approval removed its own card, so the agent stayed blocked forever
 *     on a decision the user watched disappear;
 *   - New Task cleared the prompt and closed the modal;
 *   - a chat prompt was appended to the transcript and never answered.
 *
 * `send` now returns whether the message went out, and nothing is treated as
 * done until it did. These tests drive the store with a socket that refuses.
 */
function perm(requestId: string): PendingPermission {
  return {
    requestId,
    sessionId: 's1',
    tool: 'Bash',
    args: { command: 'git push origin main' },
    receivedAt: 1000,
  };
}

/** A socket that is down. This is the default — `send` starts as () => false. */
function offline(): void {
  useSolixStore.setState({ connected: false });
  useSolixStore.getState().attachSocket(() => false);
}

function online(): { sent: unknown[] } {
  const sent: unknown[] = [];
  useSolixStore.setState({ connected: true });
  useSolixStore.getState().attachSocket((m) => {
    sent.push(m);
    return true;
  });
  return { sent };
}

beforeEach(() => {
  useSolixStore.setState({
    pendingPermissions: {},
    resolvingPermissions: new Set<string>(),
    chatBySessionId: {},
    selectedSessionIds: new Set<string>(['s1']),
    toasts: [],
  });
});

describe('a decision that could not be sent', () => {
  beforeEach(() => {
    useSolixStore.setState({ pendingPermissions: { r1: perm('r1') } });
  });

  /** The one that matters: the card is the only record that the agent is stuck. */
  it('keeps the decision card', () => {
    offline();
    useSolixStore.getState().resolvePermission('r1', true);
    expect(useSolixStore.getState().pendingPermissions.r1).toBeDefined();
  });

  it('says so, and says the agent is still waiting', () => {
    offline();
    useSolixStore.getState().resolvePermission('r1', true);
    const toast = useSolixStore.getState().toasts.at(-1);
    expect(toast?.level).toBe('error');
    expect(toast?.message).toMatch(/not sent/i);
    expect(toast?.message).toMatch(/still waiting/i);
  });

  it('does not mark it as being resolved', () => {
    offline();
    useSolixStore.getState().resolvePermission('r1', false);
    expect(useSolixStore.getState().resolvingPermissions.has('r1')).toBe(false);
  });
});

describe('a decision that was sent', () => {
  beforeEach(() => {
    useSolixStore.setState({ pendingPermissions: { r1: perm('r1') } });
  });

  /**
   * Still on screen, because "sent" is not "landed". The server confirms with
   * permission_resolved and that is what removes it.
   */
  it('keeps the card up until the server confirms', () => {
    online();
    useSolixStore.getState().resolvePermission('r1', true);
    expect(useSolixStore.getState().pendingPermissions.r1).toBeDefined();
    expect(useSolixStore.getState().resolvingPermissions.has('r1')).toBe(true);
  });

  it('sends the decision exactly once', () => {
    const { sent } = online();
    useSolixStore.getState().resolvePermission('r1', true);
    expect(sent).toEqual([
      { type: 'permission_response', requestId: 'r1', approved: true },
    ]);
  });

  it('removes the card when the server confirms', () => {
    online();
    useSolixStore.getState().resolvePermission('r1', true);
    useSolixStore.getState().applyMessage({
      type: 'permission_resolved',
      requestId: 'r1',
      sessionId: 's1',
      outcome: 'approved',
    });
    expect(useSolixStore.getState().pendingPermissions.r1).toBeUndefined();
    expect(useSolixStore.getState().resolvingPermissions.has('r1')).toBe(false);
  });

  /**
   * The second-tab case, and the gate timeout. Neither tab sent anything, and
   * both must drop the card — it is no longer answerable.
   */
  it('removes a card nobody in this tab answered', () => {
    online();
    useSolixStore.getState().applyMessage({
      type: 'permission_resolved',
      requestId: 'r1',
      sessionId: 's1',
      outcome: 'timed_out',
    });
    expect(useSolixStore.getState().pendingPermissions.r1).toBeUndefined();
  });

  it('ignores a decision on a request it does not have', () => {
    const { sent } = online();
    useSolixStore.getState().resolvePermission('ghost', true);
    expect(sent).toHaveLength(0);
  });
});

describe('a launch that could not be sent', () => {
  it('reports failure so the form can keep what you typed', () => {
    offline();
    expect(
      useSolixStore.getState().launchTask('/tmp/p', 'default', 'do a thing'),
    ).toBe(false);
  });

  it('says the prompt is still there', () => {
    offline();
    useSolixStore.getState().launchTask('/tmp/p', 'default', 'do a thing');
    expect(useSolixStore.getState().toasts.at(-1)?.message).toMatch(
      /still here/i,
    );
  });

  it('reports success when it went out', () => {
    online();
    expect(
      useSolixStore.getState().launchTask('/tmp/p', 'default', 'do a thing'),
    ).toBe(true);
  });
});

describe('a prompt that could not be sent', () => {
  /** It appeared in the transcript and was never answered. */
  it('does not appear in the transcript', () => {
    offline();
    useSolixStore.getState().sendPromptTo('s1', 'are you there?');
    expect(useSolixStore.getState().chatBySessionId.s1).toBeUndefined();
  });

  it('appears when it did go out', () => {
    online();
    expect(useSolixStore.getState().sendPromptTo('s1', 'hello')).toBe(true);
    expect(useSolixStore.getState().chatBySessionId.s1).toHaveLength(1);
  });
});

describe('a termination that could not be sent', () => {
  /** Re-selecting hundreds of rows to retry is not a recovery path. */
  it('keeps the selection', () => {
    offline();
    useSolixStore.getState().terminateSessions(['s1']);
    expect(useSolixStore.getState().selectedSessionIds.has('s1')).toBe(true);
  });

  it('says how many are still running', () => {
    offline();
    useSolixStore.getState().terminateSessions(['s1', 's2']);
    expect(useSolixStore.getState().toasts.at(-1)?.message).toMatch(
      /2 agents not stopped/i,
    );
  });

  it('clears the selection when it went out', () => {
    online();
    useSolixStore.getState().terminateSessions(['s1']);
    expect(useSolixStore.getState().selectedSessionIds.size).toBe(0);
  });
});
