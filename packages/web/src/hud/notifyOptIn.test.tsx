// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

/**
 * There was no way to grant notification permission anywhere in the app —
 * `ensurePermission` was only reachable from a background event, where the
 * browser will not prompt. This control is the gesture, and it has to be
 * visible before someone tabs away, which is why it sits in the top bar.
 */
let requestCalls = 0;
let permission: NotificationPermission;

async function load() {
  vi.resetModules();
  return import('./NotifyOptIn.js');
}

beforeEach(() => {
  requestCalls = 0;
  permission = 'default';
  class FakeNotification {
    static get permission(): NotificationPermission {
      return permission;
    }
    static requestPermission(): Promise<NotificationPermission> {
      requestCalls += 1;
      permission = 'granted';
      return Promise.resolve(permission);
    }
  }
  vi.stubGlobal('Notification', FakeNotification);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotifyOptIn', () => {
  it('offers to ask while permission is undecided', async () => {
    const { NotifyOptIn } = await load();
    render(<NotifyOptIn />);
    expect(screen.getByRole('button', { name: /notify me/i })).toBeTruthy();
  });

  it('asks the browser when clicked — the gesture that was missing', async () => {
    const { NotifyOptIn } = await load();
    render(<NotifyOptIn />);
    fireEvent.click(screen.getByRole('button', { name: /notify me/i }));
    expect(requestCalls).toBe(1);
  });

  it('gets out of the way once granted', async () => {
    permission = 'granted';
    const { NotifyOptIn } = await load();
    const { container } = render(<NotifyOptIn />);
    expect(container.textContent).toBe('');
  });

  /** Silence here is what made the original bug invisible. */
  it('says so when the browser is blocking them', async () => {
    permission = 'denied';
    const { NotifyOptIn } = await load();
    render(<NotifyOptIn />);
    expect(screen.getByText(/notifications blocked/i)).toBeTruthy();
  });

  it('renders nothing where the API does not exist', async () => {
    vi.stubGlobal('Notification', undefined);
    const { NotifyOptIn } = await load();
    const { container } = render(<NotifyOptIn />);
    expect(container.textContent).toBe('');
  });
});
