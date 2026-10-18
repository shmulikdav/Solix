// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSolixStore } from '../store/index.js';
import { Welcome } from './Welcome.js';
import { HelpPanel } from './HelpPanel.js';

/**
 * These cover the onboarding defects the audit found. Every one of them was a
 * silent failure: nothing crashed, nothing logged, the onboarding just was not
 * there.
 */

const DISMISSED_KEY = 'solix.welcome.dismissed.v1';

function session(id: string) {
  return {
    id,
    cwd: '/tmp/p',
    status: 'active',
    costUsd: 0,
    contextPct: 10,
    startedAt: 1,
    updatedAt: 1,
    toolCalls: [],
  } as unknown as ReturnType<typeof useSolixStore.getState>['sessions'][string];
}

beforeEach(() => {
  localStorage.clear();
  useSolixStore.setState({ sessions: {}, plans: {}, skills: {} });
  // @ts-expect-error -- test double
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => [] }));
});

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('Welcome — first run', () => {
  // O1, the worst of them: the modal only rendered when sessionCount === 0,
  // and `solix demo` (the README's first suggested command) seeds ~30
  // sessions. Following the quick start destroyed onboarding permanently.
  it('still shows with sessions present, so `solix demo` does not destroy it', () => {
    useSolixStore.setState({ sessions: { a: session('a'), b: session('b') } });
    render(<Welcome onPlanBuild={() => {}} onOpenCrew={() => {}} />);
    expect(screen.getByText('Pick one to start')).toBeTruthy();
  });

  it('does not show once dismissed', () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    render(<Welcome onPlanBuild={() => {}} onOpenCrew={() => {}} />);
    expect(screen.queryByText('Pick one to start')).toBeNull();
  });

  // O7: `dismissed` used to hydrate in an effect, so returning users saw one
  // frame of the modal. Reading it in the initialiser means it is never
  // rendered at all.
  it('reads the dismissed flag synchronously, with no first-render flash', () => {
    localStorage.setItem(DISMISSED_KEY, '1');
    const { container } = render(
      <Welcome onPlanBuild={() => {}} onOpenCrew={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  // O2: there was no ✕, no backdrop handler, and the Escape branch only
  // cleared `helpOpen` — already false on a genuine first run.
  it('closes on Escape', () => {
    render(<Welcome onPlanBuild={() => {}} onOpenCrew={() => {}} />);
    expect(screen.getByText('Pick one to start')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByText('Pick one to start')).toBeNull();
    expect(localStorage.getItem(DISMISSED_KEY)).toBe('1');
  });

  it('closes on the ✕ button', () => {
    render(<Welcome onPlanBuild={() => {}} onOpenCrew={() => {}} />);
    fireEvent.click(screen.getByLabelText('Close'));
    expect(screen.queryByText('Pick one to start')).toBeNull();
  });

  // O6: it was an information dump with no first action. Each choice now
  // performs the thing and closes.
  it('each choice performs its action and closes', () => {
    const onPlanBuild = vi.fn();
    render(<Welcome onPlanBuild={onPlanBuild} onOpenCrew={() => {}} />);
    fireEvent.click(screen.getByText('Plan a build'));
    expect(onPlanBuild).toHaveBeenCalled();
    expect(screen.queryByText('Pick one to start')).toBeNull();
  });

  it('labels which choices cost money and which do not', () => {
    render(<Welcome onPlanBuild={() => {}} onOpenCrew={() => {}} />);
    expect(screen.getByText(/costs money once you approve/)).toBeTruthy();
    expect(screen.getAllByText(/^free/).length).toBeGreaterThan(0);
  });
});

describe('HelpPanel', () => {
  // O3: help and Welcome were one component, and help's "Got it" wrote the
  // first-run flag — so pressing ? before reading consumed the onboarding.
  it('closing help does not write the first-run dismissed flag', () => {
    render(<HelpPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByText('Close'));
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull();
  });

  it('opening help leaves a pending first run intact', () => {
    render(<HelpPanel open onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText('Close'));
    render(<Welcome onPlanBuild={() => {}} onOpenCrew={() => {}} />);
    expect(screen.getByText('Pick one to start')).toBeTruthy();
  });

  // O5: the old legend listed 11 keys and omitted 8 that were registered.
  it('documents the shortcuts that were missing from the old legend', () => {
    render(<HelpPanel open onClose={() => {}} />);
    for (const k of ['C', 'W', '+', '−', '0', 'Space']) {
      expect(screen.getByText(k)).toBeTruthy();
    }
  });

  // D5: the structural vocabulary existed only in hover tooltips.
  it('explains the map vocabulary in readable text', () => {
    render(<HelpPanel open onClose={() => {}} />);
    for (const term of ['Sun', 'Planet', 'Moon', 'Asteroid belt', 'Flare']) {
      expect(screen.getByText(term)).toBeTruthy();
    }
  });

  it('ticks checklist items off real state, not a stored flag', async () => {
    useSolixStore.setState({ sessions: { a: session('a') } });
    render(<HelpPanel open onClose={() => {}} />);
    // Done items drop their hint; undone ones keep it.
    expect(screen.getByText('An agent has run').className).toContain(
      'line-through',
    );
    expect(screen.getByText('You planned a build').className).not.toContain(
      'line-through',
    );
  });

  it('reads "approved a decision" from the audit log', async () => {
    // @ts-expect-error -- test double
    global.fetch = vi.fn(async (url: string) =>
      /\/api\/audit/.test(url)
        ? { ok: true, json: async () => [{ kind: 'permission_approved' }] }
        : { ok: true, json: async () => [] },
    );
    render(<HelpPanel open onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText('You approved a decision').className).toContain(
        'line-through',
      ),
    );
  });
});
