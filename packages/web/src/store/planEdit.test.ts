import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanTask } from '@solix/shared';
import { useSolixStore } from './index.js';

/**
 * The store half of plan editing.
 *
 * Maestro's server has had `POST /tasks`, `PATCH /tasks/:id` and
 * `DELETE /tasks/:id` since it landed, and nothing called them. The partner
 * brief has been disclosing the consequence for weeks: "you cannot reorder,
 * retitle, retarget a model, drop a task or add one. The server endpoints for
 * all of that ship; the frontend calls two of them."
 *
 * Two behaviours here are worth pinning rather than assuming.
 *
 * The server refuses some edits with a 409 and a sentence — "an agent is
 * working on it", "already verified", "a record now". Those must reach the
 * user verbatim. A generic "could not save" would leave someone re-trying an
 * edit that the plan's state will never accept.
 *
 * And a move is two PATCHes, because the server stores an index per task and
 * has no move verb. If the second one is refused, the first has to be put
 * back: two tasks sharing an `orderIndex` is a list in an order nobody asked
 * for, and it would persist.
 */
/** Every required field, spelled out rather than cast: if `PlanTask` gains
 *  one, this stops compiling instead of quietly passing an incomplete task
 *  into the code under test. */
function task(id: string, orderIndex: number): PlanTask {
  return {
    id,
    planId: 'p1',
    title: id,
    prompt: 'do it',
    acceptanceCriteria: 'done',
    status: 'pending',
    dependsOn: [],
    orderIndex,
    attempts: 0,
    maxAttempts: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

function seedThreeTasks(): void {
  useSolixStore.setState({
    planTasks: {
      a: task('a', 0),
      b: task('b', 1),
      c: task('c', 2),
    },
  });
}

/** Captures each request so the order and bodies can be asserted. */
function mockFetch(
  responder: (url: string, init?: RequestInit) => {
    status: number;
    body: unknown;
  },
): Array<{ url: string; method: string; body: unknown }> {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const { status, body } = responder(url, init);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response);
  });
  return calls;
}

describe('editing a plan task from the store', () => {
  beforeEach(() => {
    seedThreeTasks();
    vi.unstubAllGlobals();
  });

  it('PATCHes only the fields given', async () => {
    const calls = mockFetch(() => ({ status: 200, body: { id: 'a' } }));
    const res = await useSolixStore
      .getState()
      .updatePlanTask('p1', 'a', { title: 'renamed', model: 'opus' });

    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('PATCH');
    expect(calls[0]!.url).toContain('/api/plans/p1/tasks/a');
    expect(calls[0]!.body).toEqual({ title: 'renamed', model: 'opus' });
  });

  it("passes the server's refusal through, word for word", async () => {
    // The whole reason the server returns a sentence instead of a code.
    mockFetch(() => ({
      status: 409,
      body: { error: 'this task is dispatched — an agent is working on it' },
    }));
    const res = await useSolixStore
      .getState()
      .updatePlanTask('p1', 'a', { prompt: 'something else' });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('this task is dispatched — an agent is working on it');
  });

  it('does not write the edit into the store itself', async () => {
    // The server broadcasts plan_task_upsert and the panel follows the socket.
    // An optimistic write here would show an edit that a dropped socket never
    // actually saved — the same mistake approvals used to make.
    mockFetch(() => ({ status: 200, body: { id: 'a' } }));
    await useSolixStore
      .getState()
      .updatePlanTask('p1', 'a', { title: 'renamed' });
    expect(useSolixStore.getState().planTasks.a!.title).toBe('a');
  });

  it('reports a dropped connection rather than claiming success', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    const res = await useSolixStore
      .getState()
      .updatePlanTask('p1', 'a', { title: 'renamed' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not saved/i);
  });

  describe('moving a task', () => {
    it('swaps order with its neighbour', async () => {
      const calls = mockFetch(() => ({ status: 200, body: { id: 'x' } }));
      const res = await useSolixStore.getState().movePlanTask('p1', 'b', 'up');

      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(2);
      // b takes a's index, a takes b's.
      expect(calls[0]!.url).toContain('/tasks/b');
      expect(calls[0]!.body).toEqual({ orderIndex: 0 });
      expect(calls[1]!.url).toContain('/tasks/a');
      expect(calls[1]!.body).toEqual({ orderIndex: 1 });
    });

    it('puts the first half back when the second is refused', async () => {
      // Otherwise two tasks share an index and the list is left in an order
      // nobody asked for — persisted, not just on screen.
      let n = 0;
      const calls = mockFetch(() => {
        n += 1;
        return n === 2
          ? { status: 409, body: { error: 'this task is verifying' } }
          : { status: 200, body: { id: 'x' } };
      });
      const res = await useSolixStore.getState().movePlanTask('p1', 'b', 'up');

      expect(res.ok).toBe(false);
      expect(res.error).toContain('verifying');
      expect(calls).toHaveLength(3);
      // The third call restores b's original index.
      expect(calls[2]!.url).toContain('/tasks/b');
      expect(calls[2]!.body).toEqual({ orderIndex: 1 });
    });

    it('is a no-op at the ends, without a request or an error', async () => {
      const calls = mockFetch(() => ({ status: 200, body: {} }));
      expect((await useSolixStore.getState().movePlanTask('p1', 'a', 'up')).ok).toBe(true);
      expect((await useSolixStore.getState().movePlanTask('p1', 'c', 'down')).ok).toBe(true);
      expect(calls).toHaveLength(0);
    });
  });

  it('adds a task and returns its id', async () => {
    const calls = mockFetch(() => ({ status: 200, body: { id: 'new-1' } }));
    const res = await useSolixStore
      .getState()
      .addPlanTask('p1', { title: 'extra', prompt: 'also do this' });

    expect(res).toEqual({ ok: true, taskId: 'new-1' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toContain('/api/plans/p1/tasks');
  });

  it('removes a task, and surfaces a refusal to', async () => {
    mockFetch(() => ({ status: 200, body: { ok: true } }));
    expect((await useSolixStore.getState().deletePlanTask('p1', 'a')).ok).toBe(true);

    mockFetch(() => ({
      status: 409,
      body: { error: 'this plan is completed — it is a record now' },
    }));
    const res = await useSolixStore.getState().deletePlanTask('p1', 'a');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('a record now');
  });
});
