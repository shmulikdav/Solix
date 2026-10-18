// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  selectCanResolveByKey,
  useSolixStore,
} from '../store/index.js';
import { DecisionQueue } from './DecisionQueue.js';
import { NavRail } from '../shell/NavRail.js';

/**
 * Decisions is the surface that unblocks stuck agents, so it carries more
 * regression tests than its size suggests.
 *
 * It is a dock panel now, opened from the rail, rather than a column that
 * always floated over the canvas. That is a better arrangement — the column
 * was twice found underneath something — but it moves the "something is
 * waiting" signal onto the rail and makes the keyboard shortcuts dangerous if
 * left ungated. Both are covered below.
 */
function perm(id: string, receivedAt: number) {
  return {
    requestId: id,
    sessionId: `sess-${id}`,
    tool: 'Bash',
    args: { command: `echo ${id}` },
    receivedAt,
  };
}

function seed(perms: Record<string, ReturnType<typeof perm>>) {
  useSolixStore.setState({
    pendingPermissions: perms,
    budgetAlerts: {},
    sessions: {},
    missions: {},
  });
}

afterEach(cleanup);
beforeEach(() => {
  seed({});
  useSolixStore.setState({ activePanel: null, activePanelTab: null });
});

describe('DecisionQueue', () => {
  // B1: the key handler takes [0] of the ordered selector, so the list must
  // render in that same order or Y approves a card the user never saw.
  it('renders pending requests newest-first', () => {
    seed({ older: perm('older', 1000), newer: perm('newer', 9000) });
    render(<DecisionQueue />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('echo newer');
    expect(text).toContain('echo older');
    expect(text.indexOf('echo newer')).toBeLessThan(text.indexOf('echo older'));
  });

  it('says so plainly when nothing is waiting', () => {
    render(<DecisionQueue />);
    expect(screen.getByText('Nothing waiting')).toBeTruthy();
  });

  it('states that the agent is blocked, not working around it', () => {
    seed({ a: perm('a', 1) });
    render(<DecisionQueue />);
    expect(
      screen.getByText(/the agent is paused, not working around it/),
    ).toBeTruthy();
  });
});

describe('Y / N are gated on the card being visible', () => {
  // B1 would come straight back without this. With Decisions behind a rail
  // click, an ungated shortcut resolves a real tool call the user never read.
  it('refuses to resolve while the panel is closed', () => {
    seed({ a: perm('a', 1) });
    useSolixStore.setState({ activePanel: null });
    expect(selectCanResolveByKey(useSolixStore.getState())).toBe(false);
  });

  it('allows it while the panel is open', () => {
    seed({ a: perm('a', 1) });
    useSolixStore.setState({ activePanel: 'decisions' });
    expect(selectCanResolveByKey(useSolixStore.getState())).toBe(true);
  });

  it('refuses while a different panel is open', () => {
    seed({ a: perm('a', 1) });
    useSolixStore.setState({ activePanel: 'fleet' });
    expect(selectCanResolveByKey(useSolixStore.getState())).toBe(false);
  });
});

describe('the rail carries the signal', () => {
  const railProps = {
    onNewTask: () => {},
    onOpenTimeline: () => {},
    onOpenHelp: () => {},
  };

  it('shows the pending count beside Decisions', () => {
    seed({ a: perm('a', 1), b: perm('b', 2) });
    render(<NavRail {...railProps} />);
    expect(screen.getByTitle('2 waiting on your approval')).toBeTruthy();
  });

  it('shows no count when nothing is pending', () => {
    render(<NavRail {...railProps} />);
    expect(screen.queryByTitle(/waiting on your approval/)).toBeNull();
  });

  // chime() is off unless opted into and notify() only fires when the tab is
  // hidden, so while you are looking at the app this row IS the alert.
  it('turns the row the caution colour while requests are waiting', () => {
    seed({ a: perm('a', 1) });
    const { container } = render(<NavRail {...railProps} />);
    const row = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Decisions'),
    );
    expect(row?.className).toContain('text-solix-warn');
    expect(row?.className).toContain('solix-pulse');
  });

  // B2, translated: nothing may re-open the panel behind the user's back.
  it('an arrival does not force the panel open', () => {
    render(<NavRail {...railProps} />);
    act(() => {
      seed({ a: perm('a', 1) });
    });
    expect(useSolixStore.getState().activePanel).toBeNull();
  });
});
