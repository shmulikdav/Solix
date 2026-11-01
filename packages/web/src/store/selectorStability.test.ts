import { beforeEach, describe, expect, it } from 'vitest';
import type { Goal, Session } from '@solix/shared';
import {
  selectGoalsArray,
  selectMoons,
  selectPlanets,
  selectWorkspaceSummary,
  useSolixStore,
} from './index.js';

/**
 * CLAIM-RENDERER-RELEASES-GPU · the galaxy does not re-render on every event.
 *
 * Zustand compares a selector's result with `Object.is`. Every array
 * selector here built a fresh array, so each one re-rendered its component
 * on **every** store write — not just writes touching what it read. And
 * `session_upsert`, `context_update`, `cost_update`, `tool_call` and
 * `chat_delta` each replace a top-level slice.
 *
 * With no `memo()` anywhere in `packages/web/src/scene/`, that meant one
 * cost event re-rendered every planet in the galaxy, each of which rebuilt
 * its own geometry bindings and ran `selectMoons` — a full scan of every
 * session — from inside its own render. `solix demo` seeds thirty planets,
 * so a partner meets this in the first thirty seconds.
 *
 * The tests that matter are the pair: a stable reference when nothing it
 * reads changed, and a *fresh* one when something did. A cache that never
 * invalidates is a worse bug than the one it replaced.
 */
function session(id: string, over: Partial<Session> = {}): Session {
  return {
    id,
    pid: 1,
    projectId: 'p1',
    cwd: '/tmp/x',
    status: 'idle',
    model: 'default',
    origin: 'external',
    kind: 'user',
    contextUsagePct: null,
    orbitSlot: 0,
    costUsd: 0,
    startedAt: 1,
    updatedAt: 1,
    ...over,
  } as Session;
}

function goal(id: string, orgId?: string): Goal {
  return {
    id,
    name: id,
    color: '#8899ff',
    createdAt: 1,
    ...(orgId ? { orgId } : {}),
  };
}

describe('CLAIM-RENDERER-RELEASES-GPU · selector stability', () => {
  beforeEach(() => {
    useSolixStore.setState({
      sessions: {
        a: session('a'),
        b: session('b'),
        m1: session('m1', { parentSessionId: 'a' }),
        m2: session('m2', { parentSessionId: 'a' }),
      },
      skills: {},
      goals: {},
      currentOrgId: 'org-default',
    });
  });

  it('gives back the same array when nothing it reads has changed', () => {
    const first = selectPlanets(useSolixStore.getState());
    const second = selectPlanets(useSolixStore.getState());
    expect(second).toBe(first);
  });

  it('is unmoved by a write to a slice it does not read', () => {
    // The whole point: a cost or tool event replaces one slice, and the
    // galaxy should not re-render because of it.
    const before = selectPlanets(useSolixStore.getState());
    useSolixStore.setState({ skills: { s1: { id: 's1' } as never } });
    expect(selectPlanets(useSolixStore.getState())).toBe(before);
  });

  it('does produce a new array when the sessions actually change', () => {
    // A cache that never invalidates is the worse bug.
    const before = selectPlanets(useSolixStore.getState());
    useSolixStore.setState((s) => ({
      sessions: { ...s.sessions, c: session('c') },
    }));
    const after = selectPlanets(useSolixStore.getState());
    expect(after).not.toBe(before);
    expect(after.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('groups moons once instead of scanning per planet', () => {
    const state = useSolixStore.getState();
    const first = selectMoons(state, 'a');
    expect(first.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    // Stable per planet — this one was called from inside Planet's own
    // render, so a fresh array here re-rendered the planet that asked.
    expect(selectMoons(useSolixStore.getState(), 'a')).toBe(first);
  });

  it('gives a stable empty array for a planet with no moons', () => {
    const none = selectMoons(useSolixStore.getState(), 'b');
    expect(none).toEqual([]);
    expect(selectMoons(useSolixStore.getState(), 'b')).toBe(none);
  });

  it('keeps Mission Control still while unrelated slices move', () => {
    // It returns a fresh object *and* a fresh needsYou array, so it was the
    // most expensive of the lot.
    const before = selectWorkspaceSummary(useSolixStore.getState());
    useSolixStore.setState({ recentToolCalls: [] as never });
    expect(selectWorkspaceSummary(useSolixStore.getState())).toBe(before);
  });

  it('recomputes Mission Control when the sessions change', () => {
    const before = selectWorkspaceSummary(useSolixStore.getState());
    useSolixStore.setState((s) => ({
      sessions: { ...s.sessions, d: session('d', { costUsd: 5 }) },
    }));
    const after = selectWorkspaceSummary(useSolixStore.getState());
    expect(after).not.toBe(before);
    expect(after.totalSpendUsd).toBe(5);
  });

  it('shows only the current org’s goals', () => {
    // `selectPlansArray` next door has always filtered by org; goals carried
    // an orgId nothing read, so ConstellationLines drew every org's at once.
    useSolixStore.setState({
      goals: { g1: goal('g1'), g2: goal('g2', 'acme'), g3: goal('g3', 'org-default') },
      currentOrgId: 'org-default',
    });
    expect(selectGoalsArray(useSolixStore.getState()).map((g) => g.id).sort()).toEqual(
      ['g1', 'g3'],
    );

    useSolixStore.setState({ currentOrgId: 'acme' });
    expect(selectGoalsArray(useSolixStore.getState()).map((g) => g.id)).toEqual(['g2']);
  });
});
