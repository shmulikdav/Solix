// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useSolixStore } from '../store/index.js';
import { FirstSunHint } from './FirstSunHint.js';

const SUN_HINT_KEY = 'solix.hint.sun.v1';

function session(id: string) {
  return { id, cwd: '/tmp/p', status: 'active', costUsd: 0 } as never;
}

beforeEach(() => {
  localStorage.clear();
  useSolixStore.setState({
    sessions: {},
    viewMode: 'galaxy',
    activePanel: null,
    workspaceSurface: null,
    pendingPermissions: {},
  });
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('FirstSunHint', () => {
  it('does not show while the system is still empty', () => {
    render(<FirstSunHint suppressed={false} />);
    expect(screen.queryByText(/That's the sun/)).toBeNull();
  });

  it('appears when the first session arrives', () => {
    const { rerender } = render(<FirstSunHint suppressed={false} />);
    act(() => {
      useSolixStore.setState({ sessions: { a: session('a') } });
    });
    rerender(<FirstSunHint suppressed={false} />);
    expect(screen.getByText(/That's the sun/)).toBeTruthy();
  });

  it('never shows twice', () => {
    localStorage.setItem(SUN_HINT_KEY, '1');
    useSolixStore.setState({ sessions: { a: session('a') } });
    render(<FirstSunHint suppressed={false} />);
    expect(screen.queryByText(/That's the sun/)).toBeNull();
  });

  // Two modals at once on a first run would be worse than no hint.
  it('waits while the welcome modal is up, and does not burn the flag', () => {
    useSolixStore.setState({ sessions: { a: session('a') } });
    render(<FirstSunHint suppressed />);
    expect(screen.queryByText(/That's the sun/)).toBeNull();
    expect(localStorage.getItem(SUN_HINT_KEY)).toBeNull();
  });

  // There is no sun to point at in List or Missions view.
  it('does not appear outside galaxy view', () => {
    useSolixStore.setState({
      sessions: { a: session('a') },
      viewMode: 'list',
    });
    render(<FirstSunHint suppressed={false} />);
    expect(screen.queryByText(/That's the sun/)).toBeNull();
    expect(localStorage.getItem(SUN_HINT_KEY)).toBeNull();
  });

  // Caught by a smoke screenshot: the hint was centred and the Decision Queue
  // landed on top of it. Covering a permission prompt is the exact bug class
  // this cycle already fixed once, so the hint yields instead of competing.
  it('waits while a permission is pending, and does not burn the flag', () => {
    useSolixStore.setState({
      sessions: { a: session('a') },
      pendingPermissions: {
        r1: {
          requestId: 'r1',
          sessionId: 'a',
          tool: 'Bash',
          args: {},
          receivedAt: 1,
        } as never,
      },
    });
    render(<FirstSunHint suppressed={false} />);
    expect(screen.queryByText(/That's the sun/)).toBeNull();
    expect(localStorage.getItem(SUN_HINT_KEY)).toBeNull();
  });

  it('gets out of the way once Mission Control is open', () => {
    const { rerender } = render(<FirstSunHint suppressed={false} />);
    act(() => {
      useSolixStore.setState({ sessions: { a: session('a') } });
    });
    rerender(<FirstSunHint suppressed={false} />);
    expect(screen.getByText(/That's the sun/)).toBeTruthy();
    act(() => {
      useSolixStore.setState({ workspaceSurface: { kind: 'overview' } });
    });
    rerender(<FirstSunHint suppressed={false} />);
    expect(screen.queryByText(/That's the sun/)).toBeNull();
  });
});
