import { beforeEach, describe, expect, it } from 'vitest';
import { selectWorkspaceSummary, useSolixStore } from './index.js';

/**
 * Mission Control's docstring claims "All figures are real". Three of them
 * were zeros standing in for absent data, in the panel that exists to tell
 * you what your agents cost.
 *
 * `Cost / mission` read "$0.00" whenever no mission had completed — printed
 * directly beside a `Total spend` tile showing real money, so the panel
 * contradicted itself in adjacent tiles. `Context pressure` read
 * "avg 0% · max 0%" on a fresh install, which is a measurement claim about
 * data that does not exist. The same component already handled this
 * correctly one tile over (`interventions === null ? '—'`), which is what
 * makes these bugs rather than choices.
 */
function session(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    status: 'idle',
    model: 'default',
    cwd: '/tmp/p',
    projectId: 'p1',
    contextUsagePct: 0,
    costUsd: 0,
    lastActivityAt: 1,
    kind: 'user',
    origin: 'external',
    ...over,
  };
}

beforeEach(() => {
  useSolixStore.setState({
    sessions: {},
    missions: {},
    projects: {},
    advisors: {},
    skills: {},
    pendingPermissions: {},
  } as never);
});

describe('cost per mission', () => {
  /** The exact contradiction: real spend, "$0.00" beside it. */
  it('is null, not zero, when money was spent and nothing completed', () => {
    useSolixStore.setState({
      sessions: { a: session('a', { costUsd: 14.32 }) },
    } as never);
    const s = selectWorkspaceSummary(useSolixStore.getState());
    expect(s.totalSpendUsd).toBeCloseTo(14.32);
    expect(s.costPerCompletedMission).toBeNull();
  });

  it('is a real figure once a mission completes', () => {
    useSolixStore.setState({
      sessions: { a: session('a', { costUsd: 10 }) },
      missions: {
        m1: {
          id: 'm1',
          sessionId: 'a',
          status: 'completed',
          shortName: 'm',
          startedAt: 1,
          metrics: { totalTokens: 0, toolCallCount: 0 },
        },
      },
    } as never);
    const s = selectWorkspaceSummary(useSolixStore.getState());
    expect(s.costPerCompletedMission).toBeCloseTo(10);
  });
});

describe('context pressure', () => {
  it('is null when nothing has reported usage', () => {
    const s = selectWorkspaceSummary(useSolixStore.getState());
    expect(s.contextAvgPct).toBeNull();
    expect(s.contextMaxPct).toBeNull();
  });

  it('reports real numbers once something has', () => {
    useSolixStore.setState({
      sessions: {
        a: session('a', { contextUsagePct: 40 }),
        b: session('b', { contextUsagePct: 80 }),
      },
    } as never);
    const s = selectWorkspaceSummary(useSolixStore.getState());
    expect(s.contextAvgPct).toBeCloseTo(60);
    expect(s.contextMaxPct).toBe(80);
  });
});
