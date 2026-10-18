import { describe, expect, it, beforeEach } from 'vitest';
import {
  selectPendingPermissionsOrdered,
  useSolixStore,
} from './index.js';
import type { PendingPermission } from './index.js';

/**
 * Regression test for the worst bug the pre-launch audit found.
 *
 * The `Y`/`N` keyboard shortcuts and the Decision Queue each derived their own
 * order, and the two were EXACT OPPOSITES: the key handler took
 * `Object.values(pendingPermissions)[0]` (insertion order = oldest first) while
 * the queue sorted newest-first. With two or more pending requests, pressing
 * `Y` approved the card at the bottom of the list rather than the one on
 * screen — approving an agent action the human never saw.
 *
 * Both now read `selectPendingPermissionsOrdered`. These tests pin that the
 * order is newest-first and that the two callers cannot diverge again.
 */
function perm(requestId: string, receivedAt: number): PendingPermission {
  return {
    requestId,
    sessionId: `s-${requestId}`,
    tool: 'Bash',
    args: { command: `echo ${requestId}` },
    receivedAt,
  };
}

describe('pending permission ordering', () => {
  beforeEach(() => {
    useSolixStore.setState({ pendingPermissions: {} });
  });

  it('orders newest first', () => {
    useSolixStore.setState({
      pendingPermissions: {
        old: perm('old', 1000),
        mid: perm('mid', 2000),
        new: perm('new', 3000),
      },
    });
    expect(
      selectPendingPermissionsOrdered(useSolixStore.getState()).map(
        (p) => p.requestId,
      ),
    ).toEqual(['new', 'mid', 'old']);
  });

  it('the first element is NOT insertion order when they disagree', () => {
    // Insert oldest first — exactly the case that produced the bug.
    useSolixStore.setState({
      pendingPermissions: { a: perm('a', 1000), b: perm('b', 5000) },
    });
    const insertionFirst = Object.values(
      useSolixStore.getState().pendingPermissions,
    )[0];
    const displayedFirst = selectPendingPermissionsOrdered(
      useSolixStore.getState(),
    )[0];
    expect(insertionFirst!.requestId).toBe('a'); // what the old handler used
    expect(displayedFirst!.requestId).toBe('b'); // what the user actually sees
    // The whole point: these differ, so the shortcut must use the latter.
    expect(displayedFirst!.requestId).not.toBe(insertionFirst!.requestId);
  });

  it('is stable and total for a single pending request', () => {
    useSolixStore.setState({ pendingPermissions: { only: perm('only', 1) } });
    const ordered = selectPendingPermissionsOrdered(useSolixStore.getState());
    expect(ordered).toHaveLength(1);
    expect(ordered[0]!.requestId).toBe('only');
  });

  it('is empty when nothing is pending', () => {
    expect(selectPendingPermissionsOrdered(useSolixStore.getState())).toEqual([]);
  });
});
