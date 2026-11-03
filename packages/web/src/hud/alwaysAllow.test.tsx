// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Session } from '@solix/shared';
import { useSolixStore } from '../store/index.js';
import { DecisionQueue } from './DecisionQueue.js';

/**
 * "Always allow" on a Decisions card writes the rule this request suggests,
 * scoped to the session's project, and then approves the call. On 1.18.3 a
 * five-task plan was held thirty times and the only answer was Y, thirty
 * times; this is the button that would have ended that after the first.
 */
function perm(id: string, tool: string, args: Record<string, unknown>) {
  return { requestId: id, sessionId: `sess-${id}`, tool, args, receivedAt: 1000 };
}

function session(id: string, projectId: string): Session {
  return {
    id,
    projectId,
    cwd: '/tmp/always-allow',
    status: 'awaiting_permission',
    kind: 'user',
    origin: 'internal',
    createdAt: 0,
    updatedAt: 0,
    contextUsagePct: null,
  } as unknown as Session;
}

let send: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function online(perms: Record<string, ReturnType<typeof perm>>, sessions: Record<string, Session>) {
  useSolixStore.setState({
    pendingPermissions: perms,
    budgetAlerts: {},
    sessions,
    missions: {},
    connected: true,
    activePanel: 'decisions',
    workspaceSurface: null,
    // The store outlives a test: a request id marked as sending in one test
    // would leave the card's buttons disabled in the next.
    resolvingPermissions: new Set<string>(),
  });
  send = vi.fn(() => true);
  useSolixStore.getState().attachSocket(send as unknown as (msg: unknown) => boolean);
}

afterEach(cleanup);
beforeEach(() => {
  fetchMock = vi.fn(async () => new Response('{"id":"r1"}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Always allow on a decision card', () => {
  it('offers the rule the request suggests, in words', () => {
    online({ r1: perm('r1', 'Bash', { command: 'git status --short && ls' }) }, { 'sess-r1': session('sess-r1', 'p1') });
    render(<DecisionQueue />);
    expect(screen.getByRole('button', { name: /always allow shell commands starting with `git status` in this project/i })).toBeTruthy();
  });

  it('writes a project-scoped rule and then approves the call', async () => {
    online({ r1: perm('r1', 'Read', { file_path: '/tmp/always-allow/SPEC.md' }) }, { 'sess-r1': session('sess-r1', 'p1') });
    render(<DecisionQueue />);
    fireEvent.click(screen.getByRole('button', { name: /always allow read-only tools/i }));
    await waitFor(() => expect(send).toHaveBeenCalled());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/rules');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      match: 'readonly_tool',
      decision: 'allow',
      scope: 'project',
      projectId: 'p1',
    });
    expect(send).toHaveBeenCalledWith({ type: 'permission_response', requestId: 'r1', approved: true });
  });

  it('is absent when nothing sensible can be suggested', () => {
    online({ r1: perm('r1', 'WebFetch', { url: 'https://example.com' }) }, { 'sess-r1': session('sess-r1', 'p1') });
    render(<DecisionQueue />);
    expect(screen.queryByRole('button', { name: /always allow/i })).toBeNull();
    expect(screen.getByRole('button', { name: /approve/i })).toBeTruthy();
  });

  /**
   * The rule is the durable part; the call is the urgent part. If the rule
   * does not land, the call is still answered so the agent is not left
   * waiting on a failed write — and the console says the rule is missing.
   */
  it('still approves the call when the rule does not land', async () => {
    fetchMock.mockImplementation(async () => new Response('{"error":"nope"}', { status: 500 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    online({ r1: perm('r1', 'Bash', { command: 'ls -la' }) }, { 'sess-r1': session('sess-r1', 'p1') });
    render(<DecisionQueue />);
    fireEvent.click(screen.getByRole('button', { name: /always allow/i }));
    await waitFor(() => expect(send).toHaveBeenCalled());
    expect(send).toHaveBeenCalledWith({ type: 'permission_response', requestId: 'r1', approved: true });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
