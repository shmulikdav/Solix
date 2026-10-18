// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useSolixStore } from '../store/index.js';
import { DecisionQueue } from './DecisionQueue.js';

/**
 * The Decision Queue is the surface that unblocks stuck agents, so two
 * behaviours matter more than they look:
 *
 *  - it must render in the SAME order the Y/N shortcut acts on (newest first),
 *    otherwise the key approves a request the user never saw;
 *  - collapsing it must stick while work is in flight. It used to force-expand
 *    on ANY count change while count > 0, so resolving one of three requests
 *    (3 → 2) re-opened a queue the user had just closed.
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
beforeEach(() => seed({}));

describe('DecisionQueue', () => {
  it('renders pending requests newest-first', () => {
    seed({ older: perm('older', 1000), newer: perm('newer', 9000) });
    render(<DecisionQueue panelOffsetPx={0} />);
    const text = document.body.textContent ?? '';
    // Both present, newest appearing before oldest in the DOM.
    expect(text).toContain('echo newer');
    expect(text).toContain('echo older');
    expect(text.indexOf('echo newer')).toBeLessThan(text.indexOf('echo older'));
  });

  it('stays collapsed when a request is resolved (count drops)', () => {
    seed({ a: perm('a', 1), b: perm('b', 2), c: perm('c', 3) });
    render(<DecisionQueue panelOffsetPx={0} />);

    act(() => {
      (screen.getByText('hide') as HTMLElement).click();
    });
    expect(screen.getByText('show')).toBeTruthy();

    // Resolve one — 3 → 2. The queue must NOT re-expand.
    act(() => {
      seed({ a: perm('a', 1), b: perm('b', 2) });
    });
    expect(screen.getByText('show')).toBeTruthy();
  });

  it('re-expands when something genuinely new arrives', () => {
    seed({ a: perm('a', 1) });
    render(<DecisionQueue panelOffsetPx={0} />);
    act(() => {
      (screen.getByText('hide') as HTMLElement).click();
    });
    expect(screen.getByText('show')).toBeTruthy();

    // A new request must surface even over an explicit collapse.
    act(() => {
      seed({ a: perm('a', 1), b: perm('b', 2) });
    });
    expect(screen.getByText('hide')).toBeTruthy();
  });
});
