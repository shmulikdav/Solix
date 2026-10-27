// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The signal this file exists to deliver — "an agent is blocked and waiting
 * for you" — could not reach anyone who had tabbed away.
 *
 * Permission was requested lazily from inside `notify()`, and every caller
 * passes `whenHidden: true`, so the only moment it asked was while the tab
 * was hidden. Browsers require transient user activation for
 * `Notification.requestPermission()` and Chrome will not prompt a hidden
 * tab, so the call resolved to 'default', the module-level `permissionAsked`
 * latched, and nothing asked again that page load. `ensurePermission` was
 * called from nowhere else — never from a gesture.
 *
 * The file's own header admitted it: "it's a no-op if the user never has the
 * tab in the background". The parenthesis was the whole bug.
 *
 * (The vendor prompt rule is from the Notifications spec, not something
 * these tests prove. What they pin is the thing that was in our control:
 * nothing asks from a background event, and a gesture path exists.)
 */
let requestCalls = 0;
let created: { title: string; body?: string }[];
let permission: NotificationPermission;

async function load() {
  vi.resetModules();
  return import('./notifications.js');
}

beforeEach(() => {
  requestCalls = 0;
  created = [];
  permission = 'default';

  class FakeNotification {
    static get permission(): NotificationPermission {
      return permission;
    }
    static requestPermission(): Promise<NotificationPermission> {
      requestCalls += 1;
      return Promise.resolve(permission);
    }
    constructor(title: string, opts?: { body?: string }) {
      created.push({ title, body: opts?.body });
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
  // Hidden tab: the state every caller targets.
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => true,
  });
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notify()', () => {
  /** The headline regression. */
  it('never asks for permission itself', async () => {
    const { notify } = await load();
    await notify({ title: 'agent needs you', body: 'Bash', whenHidden: true });
    expect(requestCalls).toBe(0);
  });

  it('stays silent while permission is undecided', async () => {
    const { notify } = await load();
    await notify({ title: 'agent needs you', body: 'Bash', whenHidden: true });
    expect(created).toHaveLength(0);
  });

  it('fires once permission has been granted', async () => {
    permission = 'granted';
    const { notify } = await load();
    await notify({ title: 'agent needs you', body: 'Bash', whenHidden: true });
    expect(created).toEqual([{ title: 'agent needs you', body: 'Bash' }]);
  });

  it('stays quiet when the tab is visible', async () => {
    permission = 'granted';
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    const { notify } = await load();
    await notify({ title: 'agent needs you', body: 'Bash', whenHidden: true });
    expect(created).toHaveLength(0);
  });

  it('respects the opt-out', async () => {
    permission = 'granted';
    const { notify, setNotificationsPref } = await load();
    setNotificationsPref('off');
    await notify({ title: 'agent needs you', body: 'Bash', whenHidden: true });
    expect(created).toHaveLength(0);
  });
});

describe('requestPermission()', () => {
  it('asks the browser', async () => {
    const { requestPermission } = await load();
    await requestPermission();
    expect(requestCalls).toBe(1);
  });

  /** Nothing to ask once the user has answered, either way. */
  it('does not re-ask once decided', async () => {
    permission = 'denied';
    const { requestPermission } = await load();
    expect(await requestPermission()).toBe('denied');
    expect(requestCalls).toBe(0);
  });

  it('reports a browser without the API instead of throwing', async () => {
    vi.stubGlobal('Notification', undefined);
    const { requestPermission, notificationState } = await load();
    expect(notificationState()).toBe('unsupported');
    expect(await requestPermission()).toBe('unsupported');
  });
});
