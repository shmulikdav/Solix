// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import App from '../App.js';
import { useSolixStore } from '../store/index.js';
import { clearDismissed, readDismissed } from './onboarding.js';

/**
 * Welcome.tsx's header says this regression was fixed:
 *
 *   "It is no longer the same component as help. Opening help and clicking
 *    'Got it' used to write the first-run flag, silently consuming the
 *    onboarding of anyone who pressed ? before reading it."
 *
 * The split closed the *button* path and left the *key* path wide open.
 * App's global keymap was registered with no modal guard, so pressing `?` —
 * which the modal's own footer tells you to press — opened Help on top of
 * it, and the single Escape that closed Help also fired Welcome's own
 * listener and burned the flag. There was no way back: no reset existed
 * anywhere in the app.
 *
 * onboarding.test.tsx tests Welcome and HelpPanel in isolation and never
 * mounts them together with the keymap, which is why this shipped green.
 * These tests mount the real App.
 */
beforeEach(() => {
  localStorage.clear();
  clearDismissed();
  // List view: the galaxy canvas needs WebGL, which jsdom does not have.
  useSolixStore.setState({
    viewMode: 'list',
    sessions: {},
    projects: {},
    missions: {},
    pendingPermissions: {},
    activePanel: null,
    workspaceSurface: null,
  });
});

afterEach(cleanup);

function welcomeShowing(): boolean {
  return screen.queryAllByText(/Pick one to start/i).length > 0;
}

describe('the welcome modal and the global keymap', () => {
  it('shows on a first run', () => {
    render(<App />);
    expect(welcomeShowing()).toBe(true);
  });

  /**
   * The first half of the trap. `?` opened Help *on top of* the welcome, so
   * the Escape that followed was aimed at Help and hit both listeners.
   * With `?` inert here, Escape can only mean the one modal on screen.
   */
  it('does not open Help behind its own backdrop', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.queryByText('Shortcuts')).toBeNull();
    expect(welcomeShowing()).toBe(true);
  });

  it('closes only itself on Escape, with Help never involved', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: '?' });
    fireEvent.keyDown(window, { key: 'Escape' });

    // Dismissed, which is what Escape on a modal should do — but the user
    // aimed it at this modal, not at a Help panel stacked over it, and it
    // is recoverable (see below). Previously they lost both at once.
    expect(welcomeShowing()).toBe(false);
    expect(screen.queryByText('Shortcuts')).toBeNull();
  });

  it('does not open New Task underneath it', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'l' });
    // The rail also says "New task", so match the modal's own heading.
    expect(screen.queryByText(/Launch a Claude Code session/i)).toBeNull();
  });

  /** `t` used to drop a first-time user into Timeline playback. */
  it('does not enter playback', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 't' });
    expect(useSolixStore.getState().playback.active).toBe(false);
  });

  it('does not change a view the user cannot see', () => {
    render(<App />);
    fireEvent.keyDown(window, { key: 'v' });
    expect(useSolixStore.getState().viewMode).toBe('list');
  });

  it('lets the keymap work again once dismissed', () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(welcomeShowing()).toBe(false);

    fireEvent.keyDown(window, { key: 'v' });
    expect(useSolixStore.getState().viewMode).not.toBe('list');
  });
});

/**
 * onboarding.ts's own header complains that the previous design left
 * "no other path back to it" — and the fix changed when the flag is burned
 * without adding one. DevTools was the only recovery.
 */
describe('getting back to the welcome', () => {
  it('can be re-opened from Help', () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(welcomeShowing()).toBe(false);

    fireEvent.keyDown(window, { key: '?' });
    fireEvent.click(screen.getByText(/show the welcome again/i));

    expect(welcomeShowing()).toBe(true);
    expect(readDismissed()).toBe(false);
  });
});
