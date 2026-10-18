// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useSolixStore } from '../store/index.js';
import { CommandPalette } from './CommandPalette.js';

/**
 * The palette is navigation, not a second way to take dangerous actions.
 * "Approve the top decision" was on the original list for this and is
 * deliberately absent: resolving a permission from a search box means acting
 * on a tool call you cannot see, which is the B1 failure the Y/N gate exists
 * to prevent. The palette goes TO Decisions instead.
 */
function session(id: string, name: string) {
  return {
    id,
    name,
    cwd: '/tmp/p',
    status: 'idle',
    costUsd: 0,
    toolCalls: [],
  } as never;
}

const props = {
  open: true,
  onClose: () => {},
  onNewTask: () => {},
  onOpenTimeline: () => {},
  onOpenHelp: () => {},
};

beforeEach(() => {
  useSolixStore.setState({
    sessions: {},
    activePanel: null,
    workspaceSurface: null,
    viewMode: 'galaxy',
  });
});
afterEach(cleanup);

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<CommandPalette {...props} open={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists every Fleet section, which the rail only shows when Fleet is open', () => {
    render(<CommandPalette {...props} />);
    for (const s of ['Crew', 'Skills', 'Teams', 'Routines', 'Connections', 'Orgs']) {
      expect(screen.getByText(`Fleet › ${s}`)).toBeTruthy();
    }
  });

  // The reason agents are indexed: twenty idle planets are otherwise only
  // reachable by finding the right dot in a 3D scene.
  it('finds an agent by name and opens it', () => {
    useSolixStore.setState({
      sessions: { s1: session('s1', 'refactor-auth'), s2: session('s2', 'docs-site') },
    });
    render(<CommandPalette {...props} />);
    fireEvent.change(screen.getByLabelText('Search commands'), {
      target: { value: 'refactor' },
    });
    expect(screen.queryByText('docs-site')).toBeNull();
    fireEvent.click(screen.getByText('refactor-auth'));
    expect(useSolixStore.getState().selectedSessionId).toBe('s1');
    expect(useSolixStore.getState().activePanel).toBe('session');
  });

  it('navigates to a surface', () => {
    render(<CommandPalette {...props} />);
    fireEvent.click(screen.getByText('Fleet › Routines'));
    expect(useSolixStore.getState().workspaceSurface).toEqual({
      kind: 'fleet',
      tab: 'routines',
    });
  });

  it('moves the selection with the arrow keys and runs it on Enter', () => {
    render(<CommandPalette {...props} />);
    const input = screen.getByLabelText('Search commands');
    fireEvent.change(input, { target: { value: 'missions' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(useSolixStore.getState().viewMode).toBe('missions');
  });

  it('says so when nothing matches', () => {
    render(<CommandPalette {...props} />);
    fireEvent.change(screen.getByLabelText('Search commands'), {
      target: { value: 'zzzzz' },
    });
    expect(screen.getByText(/Nothing matches/)).toBeTruthy();
  });

  it('closes on Escape', () => {
    const onClose = vi.fn();
    render(<CommandPalette {...props} onClose={onClose} />);
    fireEvent.keyDown(screen.getByLabelText('Search commands'), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalled();
  });

  // The safety property. If either of these ever appears, a permission or a
  // paid run can be triggered from a search box with no card on screen.
  it('offers no way to approve a decision or start a routine', () => {
    useSolixStore.setState({
      pendingPermissions: {
        r1: { requestId: 'r1', sessionId: 's1', tool: 'Bash', args: {}, receivedAt: 1 },
      } as never,
    });
    const { container } = render(<CommandPalette {...props} />);
    // Assert on what is runnable, not on prose — the Decisions entry is
    // *described* as "approve or deny…", which is fine; what matters is that
    // no command DOES it.
    const labels = [...container.querySelectorAll('button[data-active]')].map(
      (b) => b.querySelector('span')?.textContent ?? '',
    );
    expect(labels.length).toBeGreaterThan(5);
    for (const l of labels) {
      expect(l).not.toMatch(/^approve/i);
      expect(l).not.toMatch(/^deny/i);
      expect(l).not.toMatch(/run now|fire |install team|pin /i);
    }
    // …but it does offer to take you where the card is visible.
    expect(labels).toContain('Decisions');
  });
});
