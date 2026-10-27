// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { Toasts } from './Toasts.js';
import { ListView } from './ListView.js';
import { useSolixStore } from '../store/index.js';

afterEach(cleanup);

/**
 * Every error the product raises goes through Toasts, and none of it was
 * announced: no aria-live, no role, no icon, no text prefix. Level was
 * carried by hue alone, so a colour-blind user could not tell an error from
 * a status ping and a screen-reader user got nothing — and they
 * auto-dismiss after five seconds, so there is no second chance.
 *
 * ConnectionDot, one file over, already carried its state in fill AND
 * motion AND a word.
 */
describe('Toasts', () => {
  beforeEach(() => {
    useSolixStore.setState({ toasts: [] });
  });

  it('lives in an announced region', () => {
    const { container } = render(<Toasts />);
    const region = container.querySelector('[aria-live]');
    expect(region).toBeTruthy();
    expect(region?.getAttribute('aria-live')).toBe('assertive');
  });

  it('says "Error" in words, not only in red', () => {
    useSolixStore.setState({
      toasts: [{ id: 't1', level: 'error', message: 'that decision was not sent' }],
    });
    render(<Toasts />);
    expect(screen.getByText('Error:')).toBeTruthy();
  });

  it('distinguishes a warning from an error without colour', () => {
    useSolixStore.setState({
      toasts: [
        { id: 't1', level: 'error', message: 'broke' },
        { id: 't2', level: 'warn', message: 'careful' },
      ],
    });
    render(<Toasts />);
    expect(screen.getByText('Error:')).toBeTruthy();
    expect(screen.getByText('Warning:')).toBeTruthy();
  });

  it('tells you the click dismisses it', () => {
    useSolixStore.setState({
      toasts: [{ id: 't1', level: 'info', message: 'done' }],
    });
    render(<Toasts />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(
      /dismiss/i,
    );
  });
});

/**
 * Opening an agent from the List was mouse-only: a bare onClick on a <tr>
 * with no role, tabIndex or key handler. The only focusable things in a row
 * were the multi-select checkbox and a Terminate button that is invisible
 * until hover — so tabbing through hundreds of rows could not open any of
 * them. Eight of eleven sortable headers were `<th onClick>` with no
 * aria-sort, so sort direction existed only as a ▲ / ▼ glyph.
 */
describe('ListView without a mouse', () => {
  function session(id: string) {
    return {
      id,
      name: id,
      status: 'idle',
      model: 'default',
      cwd: '/tmp/proj',
      projectId: 'p1',
      contextUsagePct: 0,
      costUsd: 0,
      lastActivityAt: 1,
      kind: 'user',
      origin: 'external',
    };
  }

  beforeEach(() => {
    localStorage.clear();
    useSolixStore.setState({
      sessions: { a: session('a') },
      projects: {
        p1: { id: 'p1', name: 'proj', cwd: '/tmp/proj', lastActiveAt: 5 },
      },
      missions: {},
      advisors: {},
      pendingPermissions: {},
      selectedSessionIds: new Set<string>(),
      selectedSessionId: null,
    } as never);
  });

  it('opens an agent with the keyboard', () => {
    render(<ListView />);
    const row = screen.getByRole('button', { name: /open a/i });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useSolixStore.getState().selectedSessionId).toBe('a');
  });

  it('puts the rows in the tab order', () => {
    render(<ListView />);
    expect(
      screen.getByRole('button', { name: /open a/i }).getAttribute('tabindex'),
    ).toBe('0');
  });

  it('sorts from the keyboard and says which way', () => {
    const { container } = render(<ListView />);
    const header = screen.getByRole('button', { name: /^Agent/ });
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(container.querySelector('[aria-sort="ascending"]')).toBeTruthy();
  });

  it('gives the dot column a name a reader can find', () => {
    render(<ListView />);
    expect(screen.getByText('Needs attention')).toBeTruthy();
  });

  it('marks unsorted columns as such rather than leaving it unsaid', () => {
    const { container } = render(<ListView />);
    expect(container.querySelectorAll('[aria-sort="none"]').length).toBeGreaterThan(0);
  });
});
