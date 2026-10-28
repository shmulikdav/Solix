import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { HookEvent } from '@solix/shared';
import { createSolixServer, type SolixServerHandle } from './create.js';
import { resetDbForTests, type DB } from './db.js';
import { ensureProject } from './state/projects.js';
import { upsertSession } from './state/sessions.js';
import { setGovernanceLevel } from './state/governance.js';
import { listAudit } from './state/audit.js';

/**
 * Shutting down while a decision is still on screen.
 *
 * `createSolixServer` had no test of any kind, and its `close()` was
 * `server.close(() => resolve())`. `http.Server.close()` does not call back
 * until every open request has ended — and a held permission *is* an open
 * request, one whose only possible answer is a human in the UI that is
 * going down with us. So `close()` waited for the gate's own 300s timer to
 * fire inside the dying process.
 *
 * Found by walking the partner brief against the published 1.18.0, where the
 * brief's own step 2 is "kill the Solix server mid-hold". Two things went
 * wrong, neither of them the safety property:
 *
 *   - `solix` ignored Ctrl+C. It printed "SIGINT — shutting down" and then
 *     sat there, because `await handle.close()` never resolved, so the
 *     `process.exit(0)` after it never ran.
 *   - the agent stayed blocked for five minutes. The audit log recorded the
 *     hold opening at 17:01:41 and "Timed out after 300s and was denied" at
 *     17:06:41 — the gate's own backstop, not the shutdown, refused it.
 *
 * The canary file survived throughout, so nothing destructive ran and
 * fail-closed held. But `docs/E2E-SMOKE-TEST.md` promised the hook's "curl
 * fails at once ... seconds, not the 305s --max-time ceiling", and a partner
 * following the brief sees an agent that appears to hang.
 */

const SESSION_ID = 'shutdown-while-held';

/** A port nothing else is on, so this can run beside the other suites. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function heldEvent(command: string): HookEvent {
  return {
    event: 'pre_tool_bash',
    pid: 4242,
    cwd: '/tmp/shutdown-held',
    ts: Date.now(),
    payload: {
      session_id: SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command },
    },
  } as HookEvent;
}

describe('shutting down while a request is held', () => {
  let db: DB;
  let handle: SolixServerHandle | null = null;
  let prevHome: string | undefined;
  let prevAgentView: string | undefined;

  beforeEach(() => {
    prevHome = process.env.SOLIX_HOME;
    prevAgentView = process.env.SOLIX_DISABLE_AGENTVIEW;
    process.env.SOLIX_HOME = mkdtempSync(join(tmpdir(), 'solix-shutdown-'));
    // Don't scan the real ~/.claude/jobs from a unit test.
    process.env.SOLIX_DISABLE_AGENTVIEW = '1';
    db = resetDbForTests();
    const project = ensureProject(db, '/tmp/shutdown-held');
    upsertSession(db, {
      id: SESSION_ID,
      pid: 4242,
      projectId: project.id,
      cwd: '/tmp/shutdown-held',
      origin: 'internal',
    });
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    if (prevHome === undefined) delete process.env.SOLIX_HOME;
    else process.env.SOLIX_HOME = prevHome;
    if (prevAgentView === undefined) delete process.env.SOLIX_DISABLE_AGENTVIEW;
    else process.env.SOLIX_DISABLE_AGENTVIEW = prevAgentView;
  });

  /** The hold flips the session to `awaiting_permission`, which is the same
   *  signal the rail's pending count is drawn from. */
  function isHolding(): boolean {
    const row = db
      .prepare('SELECT status FROM sessions WHERE id = ?')
      .get(SESSION_ID) as { status?: string } | undefined;
    return row?.status === 'awaiting_permission';
  }

  async function waitForHold(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isHolding()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('the server never held the request');
  }

  it('close() does not wait for the hold, so Ctrl+C can quit', async () => {
    setGovernanceLevel(db, 'strict');
    const port = await freePort();
    handle = await createSolixServer({ port });

    // A real in-flight gate request, over the wire, left unanswered — the
    // card a partner is looking at when they decide to stop Solix. The
    // socket is dropped on shutdown, which is the point, so swallow it.
    const inFlight = fetch(`http://127.0.0.1:${port}/events/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(heldEvent('echo still-deciding')),
    }).catch(() => null);

    await waitForHold(5000);

    const started = Date.now();
    await handle.close();
    const elapsed = Date.now() - started;
    handle = null;

    // The bug made this ~300_000. The generous ceiling is about CI noise,
    // not tolerance: anything near the old number is the bug back.
    expect(elapsed).toBeLessThan(5000);

    // And it must not go quietly — the same mistake the 300s timeout made.
    const denials = listAudit(db, { limit: 20 }).filter(
      (r) => r.kind === 'permission_denied',
    );
    expect(denials.map((r) => r.summary).join('\n')).toMatch(
      /Solix shut down while this was held/,
    );

    await inFlight;
  }, 30_000);

  it('an open browser tab does not keep it alive either', async () => {
    // The second half of the same bug, and the likelier one: the brief tells
    // you to kill the server while you are looking at the UI. A websocket is
    // a socket the HTTP server waits for on close, and `closeAllConnections`
    // cannot reach it because Node stops tracking a socket once it has been
    // upgraded. Measured before the fix: a client with a 20s lifetime held a
    // signalled server up for 16.2s. After: 222ms with the client holding for
    // five minutes.
    setGovernanceLevel(db, 'strict');
    const port = await freePort();
    handle = await createSolixServer({ port });

    const tab = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((done, fail) => {
      tab.once('open', () => done());
      tab.once('error', fail);
    });

    const inFlight = fetch(`http://127.0.0.1:${port}/events/permission`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(heldEvent('echo tab-is-open')),
    }).catch(() => null);
    await waitForHold(5000);

    const started = Date.now();
    await handle.close();
    const elapsed = Date.now() - started;
    handle = null;

    expect(elapsed).toBeLessThan(5000);
    tab.terminate();
    await inFlight;
  }, 30_000);

  it('a shutdown with nothing held still closes cleanly', async () => {
    const port = await freePort();
    handle = await createSolixServer({ port });
    const started = Date.now();
    await handle.close();
    handle = null;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(
      listAudit(db, { limit: 20 }).filter((r) => r.kind === 'permission_denied'),
    ).toHaveLength(0);
  }, 20_000);
});
