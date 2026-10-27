// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ListView } from './ListView.js';
import { useSolixStore } from '../store/index.js';

/**
 * With 473 agents across a dozen projects — most of them idle sessions
 * imported from months of history — the List is unreadable without a way to
 * put a group away. Collapsing is the smallest thing that fixes that.
 *
 * The property worth testing is not that it hides rows. It is that hiding
 * them cannot hide an agent that is waiting on you: a collapsed group has to
 * say so on its header, or the List becomes a way to lose a held command.
 */
const KEY = 'solix.list.collapsed.v1';

function session(id: string, over: Record<string, unknown> = {}) {
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
    ...over,
  };
}

function seed(extra: Record<string, unknown> = {}) {
  useSolixStore.setState({
    sessions: {
      a: session('a'),
      b: session('b'),
    },
    projects: { p1: { id: 'p1', name: 'solix-qa', cwd: '/tmp/proj', lastActiveAt: 5 } },
    missions: {},
    advisors: {},
    pendingPermissions: {},
    selectedSessionIds: new Set<string>(),
    ...extra,
  } as never);
}

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  seed();
});

describe('List view: collapsing a project', () => {
  it('shows its agents by default', () => {
    render(<ListView />);
    expect(screen.queryByText('a')).toBeTruthy();
    expect(screen.queryByText('b')).toBeTruthy();
  });

  it('hides them when the header is clicked, and brings them back', () => {
    render(<ListView />);
    const toggle = screen.getByRole('button', { name: /collapse solix-qa/i });

    fireEvent.click(toggle);
    expect(screen.queryByText('a')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /expand solix-qa/i }));
    expect(screen.queryByText('a')).toBeTruthy();
  });

  it('still names the project and its agent count while collapsed', () => {
    render(<ListView />);
    const toggle = screen.getByRole('button', { name: /collapse solix-qa/i });
    fireEvent.click(toggle);
    // Read the header itself, not the page — "2 agents" also appears in the
    // view's own total.
    const header = screen.getByRole('button', { name: /expand solix-qa/i });
    expect(header.textContent).toContain('solix-qa');
    expect(header.textContent).toMatch(/2 agents/i);
  });

  /**
   * The one that matters. Collapsing is for putting noise away; it must not
   * also put away the signal the whole product exists to deliver.
   */
  it('says on the header when a collapsed group holds an agent waiting on you', () => {
    seed({
      pendingPermissions: {
        r1: {
          requestId: 'r1',
          sessionId: 'a',
          tool: 'Bash',
          args: { command: 'rm -rf ./canary' },
          receivedAt: 1,
        },
      },
    });
    render(<ListView />);
    fireEvent.click(screen.getByRole('button', { name: /collapse solix-qa/i }));

    expect(screen.queryByText(/needs? you/i)).toBeTruthy();
  });

  it('remembers the choice across a reload', () => {
    const { unmount } = render(<ListView />);
    fireEvent.click(screen.getByRole('button', { name: /collapse solix-qa/i }));
    unmount();

    render(<ListView />);
    expect(screen.queryByText('a')).toBeNull();
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toContain('p1');
  });

  /**
   * Storing the COLLAPSED set rather than the expanded one means a project
   * discovered later shows up open. Storing the inverse would hide every new
   * project behind a click nobody knows to make.
   */
  it('opens a project it has never seen before', () => {
    localStorage.setItem(KEY, JSON.stringify(['some-other-project']));
    render(<ListView />);
    expect(screen.queryByText('a')).toBeTruthy();
  });
});
