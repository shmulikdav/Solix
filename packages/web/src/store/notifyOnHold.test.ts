import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerMessage } from '@solix/shared';

/**
 * "Walk away mid-hold" — the wiring, not the notifier.
 *
 * `docs/PARTNER-BRIEF.md` makes this step 3 of the twenty minutes that
 * matter: *"Click `notify me` in the top bar first. You should hear about it
 * rather than coming back to a stalled agent."*
 *
 * `notifications.test.ts` covers the notifier thoroughly in isolation — it
 * fires when granted, stays quiet while the tab is visible, respects the
 * opt-out, never asks for permission itself. `notifyOptIn.test.tsx` covers
 * the button in all four permission states.
 *
 * What nothing covered is the one line that connects them: the
 * `permission_request` branch of `applyMessage`. Delete that call, or flip
 * its `whenHidden`, and every one of those tests still passes while the
 * product's central signal never reaches anyone. The brief promises this
 * works, so something should fail when it does not.
 */
const notify = vi.fn();
const chime = vi.fn();
vi.mock('../notifications.js', () => ({
  notify: (...args: unknown[]) => notify(...args),
  chime: () => chime(),
  notificationState: () => 'granted',
  requestPermission: () => Promise.resolve('granted'),
  notificationsPref: () => 'on',
  setNotificationsPref: () => {},
}));

const { useSolixStore } = await import('./index.js');

function holdFor(sessionId: string, command: string): ServerMessage {
  return {
    type: 'permission_request',
    sessionId,
    tool: 'Bash',
    args: { command },
    requestId: 'req-1',
  } as ServerMessage;
}

describe('CLAIM-NOTIFY-ON-HOLD · a hold reaches someone who walked away', () => {
  beforeEach(() => {
    notify.mockClear();
    chime.mockClear();
    useSolixStore.setState({ pendingPermissions: {}, sessions: {} });
  });

  it('notifies when an agent starts waiting', () => {
    useSolixStore.getState().applyMessage(holdFor('s1', 'rm -rf build'));
    expect(notify).toHaveBeenCalledTimes(1);
  });

  /** The options the store passed to notify() for the first call. */
  function firstCall(): Record<string, unknown> {
    const call = notify.mock.calls[0];
    if (!call) throw new Error('notify() was never called');
    return call[0] as Record<string, unknown>;
  }

  it('only fires while the tab is hidden — the point of the feature', () => {
    // The Decision Queue and the red flare already cover the case where you
    // are looking at the page. Firing a desktop notification then is noise,
    // and dropping `whenHidden` is the easy way to break this quietly.
    useSolixStore.getState().applyMessage(holdFor('s1', 'rm -rf build'));
    expect(firstCall().whenHidden).toBe(true);
  });

  it('says which agent and what it wants, not just that something happened', () => {
    useSolixStore.getState().applyMessage(holdFor('s1', 'git push --force'));
    const opts = firstCall() as {
      title: string;
      body: string;
      tag?: string;
    };
    // Coming back to "an agent needs you" with eight planets up is not an
    // answer to which one.
    expect(opts.title).toMatch(/needs you/);
    expect(opts.body).toContain('Bash');
    expect(opts.body).toContain('git push --force');
    // Tagged per session, so a chatty agent replaces its own notification
    // rather than stacking them.
    expect(opts.tag).toContain('s1');
  });

  it('still chimes for someone who is looking at it', () => {
    useSolixStore.getState().applyMessage(holdFor('s1', 'rm -rf build'));
    expect(chime).toHaveBeenCalledTimes(1);
  });
});
