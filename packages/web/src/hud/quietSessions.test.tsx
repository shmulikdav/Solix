// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Session } from '@solix/shared';

import { SceneControls } from './SceneControls.js';
import { QUIET_AFTER_MS, selectPlanets, selectQuietCount, selectScenePlanets, useSolixStore } from '../store/index.js';

/**
 * CLAIM-GALAXY-HIDES-QUIET. The galaxy does not draw idle sessions that have
 * been quiet for over a day, says how many it is not drawing, and shows them
 * on request. It never hides a session that is working, waiting on you,
 * recent, or selected.
 *
 * Measured on 2026-11-03 on the owner's machine: 481 sessions, 464 idle, and
 * the galaxy an unreadable cloud. A backfill (`solix import`) creates idle
 * sessions with no process, which the server's liveness sweep cannot retire.
 */
const NOW = Date.now();
const OLD = NOW - QUIET_AFTER_MS - 3 * 3600_000;
const RECENT = NOW - 3600_000;

function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    pid: 0,
    projectId: 'p1',
    cwd: '/tmp/x',
    status: 'idle',
    model: 'default',
    origin: 'external',
    kind: 'user',
    contextUsagePct: null,
    orbitSlot: 0,
    costUsd: 0,
    startedAt: OLD,
    updatedAt: OLD,
    ...over,
  } as Session;
}

const initial = useSolixStore.getState();

function load(sessions: Session[], extra: Record<string, unknown> = {}): void {
  useSolixStore.setState({
    ...initial,
    sessions: Object.fromEntries(sessions.map((s) => [s.id, s])),
    showQuietSessions: false,
    selectedSessionId: null,
    viewMode: 'galaxy',
    workspaceSurface: null,
    ...extra,
  } as never);
}

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => cleanup());

describe('CLAIM-GALAXY-HIDES-QUIET: which planets the galaxy draws', () => {
  const fleet = [
    session('quiet-1'),
    session('quiet-2'),
    session('recent-idle', { updatedAt: RECENT }),
    session('old-but-active', { status: 'active' }),
    session('old-but-waiting', { status: 'awaiting_permission' }),
    session('old-awaiting-input', { status: 'awaiting_input' }),
  ];

  it('hides idle sessions quiet for over a day, and nothing else', () => {
    load(fleet);
    const drawn = selectScenePlanets(useSolixStore.getState()).map((s) => s.id).sort();
    expect(drawn).toEqual(['old-awaiting-input', 'old-but-active', 'old-but-waiting', 'recent-idle']);
    expect(selectQuietCount(useSolixStore.getState())).toBe(2);
  });

  it('never hides the session you selected', () => {
    load(fleet, { selectedSessionId: 'quiet-1' });
    expect(selectScenePlanets(useSolixStore.getState()).map((s) => s.id)).toContain('quiet-1');
  });

  it('draws everything when asked, and List is never filtered', () => {
    load(fleet, { showQuietSessions: true });
    expect(selectScenePlanets(useSolixStore.getState())).toHaveLength(fleet.length);
    load(fleet);
    expect(selectPlanets(useSolixStore.getState())).toHaveLength(fleet.length);
  });

  it('returns the same array when nothing is hidden, so a small galaxy does not re-render', () => {
    load([session('a', { status: 'active' }), session('b', { updatedAt: RECENT })]);
    const s = useSolixStore.getState();
    expect(selectScenePlanets(s)).toBe(selectPlanets(s));
  });
});

describe('CLAIM-GALAXY-HIDES-QUIET: the galaxy says what it is not drawing', () => {
  it('shows the hidden count and reveals them on click, remembering the choice', () => {
    load([session('q1'), session('q2'), session('q3'), session('live', { status: 'active' })]);
    render(<SceneControls />);

    const chip = screen.getByRole('button', { name: /3 quiet sessions hidden · Show/ });
    fireEvent.click(chip);

    expect(useSolixStore.getState().showQuietSessions).toBe(true);
    expect(selectScenePlanets(useSolixStore.getState())).toHaveLength(4);
    expect(screen.getByRole('button', { name: /Hide 3 quiet sessions/ })).toBeTruthy();
    expect(localStorage.getItem('solix.galaxy.showQuiet.v1')).toBe('1');
  });

  it('says nothing when nothing is quiet', () => {
    load([session('live', { status: 'active' })]);
    render(<SceneControls />);
    expect(screen.queryByText(/quiet session/)).toBeNull();
  });
});

describe('CLAIM-GALAXY-HIDES-QUIET: every galaxy layer draws the same planets', () => {
  // The 3D scene can't render in jsdom, so this pins the wiring at the
  // source: planets, project labels and constellation lines must all read
  // the filtered list, or a hidden planet keeps its label and its lines.
  it.each(['Scene.tsx', 'ProjectLabels.tsx', 'ConstellationLines.tsx'])('%s reads selectScenePlanets', async (file) => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // jsdom's import.meta.url is a server path, so resolve from the repo root.
    const src = readFileSync(join(process.cwd(), 'packages/web/src/scene', file), 'utf8');
    expect(src).toContain('useSolixStore(selectScenePlanets)');
    expect(src).not.toContain('useSolixStore(selectPlanets)');
  });
});

describe('CLAIM-GALAXY-HIDES-QUIET: the top bar counts what is live', () => {
  it('leaves quiet idle sessions out of the counts, whatever the galaxy toggle says', async () => {
    const { selectCountedPlanets } = await import('../store/index.js');
    const fleet = [session('q1'), session('q2'), session('recent', { updatedAt: RECENT }), session('live', { status: 'active' })];
    load(fleet, { showQuietSessions: true });
    expect(selectCountedPlanets(useSolixStore.getState()).map((s) => s.id).sort()).toEqual(['live', 'recent']);
    load(fleet, { showQuietSessions: false });
    expect(selectCountedPlanets(useSolixStore.getState())).toHaveLength(2);
  });

  it('TopBar counts from selectCountedPlanets', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'packages/web/src/hud/TopBar.tsx'), 'utf8');
    expect(src).toContain('useSolixStore(selectCountedPlanets)');
    expect(src).not.toContain('useSolixStore(selectPlanets)');
  });
});
