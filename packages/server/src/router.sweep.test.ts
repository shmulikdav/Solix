import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';

import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { ensureProject } from './state/projects.js';
import { getSession, listActiveSessions, setSessionStatus, upsertSession } from './state/sessions.js';
import type { HookEvent, ServerMessage, SessionOrigin, SessionStatus } from '@solix/shared';

/**
 * CLAIM-DEAD-SESSIONS-RETIRE. A session whose `claude` process has ended stops
 * counting as active or idle, and leaves the galaxy.
 *
 * Measured on 2026-11-03 on the owner's machine: "17 active · 464 idle" among
 * 481 sessions, with a handful of `claude` processes actually running. Solix
 * does not install Claude Code's session-end hook, so nothing ever ended a
 * session except the Terminate button.
 *
 * These use real processes (`sleep`), not a stubbed liveness check, because
 * the property is about the operating system's answer.
 */
const CWD = '/tmp/sweep-project';
const children: ChildProcess[] = [];

function liveProcess(): ChildProcess {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' });
  children.push(c);
  return c;
}

async function deadPid(): Promise<number> {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' });
  const pid = c.pid!;
  await new Promise<void>((done) => {
    c.once('exit', () => done());
    c.kill('SIGKILL');
  });
  return pid;
}

function seed(
  db: DB,
  id: string,
  pid: number,
  opts: { status?: SessionStatus; origin?: SessionOrigin; updatedAt?: number } = {},
): void {
  const project = ensureProject(db, CWD);
  upsertSession(db, {
    id,
    pid,
    projectId: project.id,
    cwd: CWD,
    origin: opts.origin ?? 'external',
    model: 'default',
    kind: 'user',
  });
  if (opts.status) setSessionStatus(db, id, opts.status);
  if (opts.updatedAt) db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(opts.updatedAt, id);
}

function event(sessionId: string, pid: number, name: HookEvent['event'] = 'post_tool'): HookEvent {
  return {
    event: name,
    pid,
    cwd: CWD,
    ts: Date.now(),
    payload: { session_id: sessionId, tool_name: 'Bash', tool_input: { command: 'ls' } },
  } as HookEvent;
}

describe('CLAIM-DEAD-SESSIONS-RETIRE: a session whose process has ended is retired', () => {
  let db: DB;
  let router: EventRouter;
  let sent: ServerMessage[];

  beforeEach(() => {
    db = resetDbForTests();
    const broadcaster = new Broadcaster();
    sent = [];
    vi.spyOn(broadcaster, 'broadcast').mockImplementation((m: ServerMessage) => void sent.push(m));
    router = new EventRouter(db, broadcaster);
  });
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
  });

  it('keeps a session whose process is running, and retires it once the process ends', async () => {
    const proc = liveProcess();
    seed(db, 's1', proc.pid!, { status: 'active' });

    expect(router.sweepDeadSessions()).toEqual([]);
    expect(getSession(db, 's1')?.status).toBe('active');

    await new Promise<void>((done) => {
      proc.once('exit', () => done());
      proc.kill('SIGKILL');
    });

    expect(router.sweepDeadSessions()).toEqual(['s1']);
    expect(getSession(db, 's1')?.status).toBe('terminated');
    expect(sent).toContainEqual({ type: 'session_remove', sessionId: 's1' });
    expect(listActiveSessions(db).map((s) => s.id)).not.toContain('s1');
  });

  it('retires dead sessions in every live-looking state — the "17 active · 464 idle" case', async () => {
    const pid = await deadPid();
    const states: SessionStatus[] = ['active', 'idle', 'awaiting_input', 'plan_review'];
    states.forEach((st, i) => seed(db, `d${i}`, pid, { status: st }));

    expect(router.sweepDeadSessions().sort()).toEqual(['d0', 'd1', 'd2', 'd3']);
    for (let i = 0; i < states.length; i++) expect(getSession(db, `d${i}`)?.status).toBe('terminated');
  });

  it('dates the end to the last activity, not to the sweep', async () => {
    const lastSeen = Date.now() - 90 * 24 * 3600_000;
    seed(db, 'old', await deadPid(), { status: 'idle', updatedAt: lastSeen });

    router.sweepDeadSessions();

    const row = db.prepare('SELECT terminated_at FROM sessions WHERE id = ?').get('old') as { terminated_at: number };
    expect(row.terminated_at).toBe(lastSeen);
  });

  it('leaves alone what it cannot judge: Agent View, spawning, unknown pid, Solix itself', async () => {
    const dead = await deadPid();
    seed(db, 'agentview', dead, { status: 'active', origin: 'agentview' });
    seed(db, 'spawning', dead, { status: 'spawning' });
    seed(db, 'nopid', 0, { status: 'active' });
    seed(db, 'self', process.pid, { status: 'active' });

    expect(router.sweepDeadSessions()).toEqual([]);
  });

  it('never retires a session whose reported pid was already gone while its events kept arriving', async () => {
    // A hook run by a short-lived shell, or a session on another machine:
    // the pid it reports is not the agent's, so its absence proves nothing.
    const notTheAgent = await deadPid();
    seed(db, 'remote', notTheAgent, { status: 'active' });

    router.handleHookEvent(event('remote', notTheAgent));

    expect(router.sweepDeadSessions()).toEqual([]);
    expect(getSession(db, 'remote')?.status).not.toBe('terminated');
  });

  it('a permission request counts as an event for that check too', async () => {
    const notTheAgent = await deadPid();
    seed(db, 'remote2', notTheAgent, { status: 'active' });

    void router.requestPermission(event('remote2', notTheAgent, 'pre_tool_bash')).catch(() => {});

    expect(router.sweepDeadSessions()).not.toContain('remote2');
  });

  it('a retired session that turns out to be alive comes back on its next event', async () => {
    const dead = await deadPid();
    seed(db, 'back', dead, { status: 'idle' });
    router.sweepDeadSessions();
    expect(getSession(db, 'back')?.status).toBe('terminated');

    const proc = liveProcess();
    router.handleHookEvent(event('back', proc.pid!, 'session_start'));

    expect(getSession(db, 'back')?.status).not.toBe('terminated');
  });
});

describe('CLAIM-DEAD-SESSIONS-RETIRE · the server sweeps at startup', () => {
  const env = { ...process.env };
  let handle: { close: () => Promise<void> } | null = null;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    process.env.SOLIX_HOME = mkdtempSync(join(tmpdir(), 'solix-sweep-'));
    process.env.SOLIX_DISABLE_AGENTVIEW = '1';
    delete process.env.SOLIX_DEMO;
  });
  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    process.env = { ...env };
  });

  async function start(sessionSweepMs?: number) {
    const { createSolixServer } = await import('./create.js');
    const { createServer } = await import('node:net');
    const port = await new Promise<number>((done) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const a = s.address();
        s.close(() => done(typeof a === 'object' && a ? a.port : 0));
      });
    });
    handle = await createSolixServer({ port, sessionSweepMs });
  }

  it('retires a session left by a process that ended before Solix started', async () => {
    const db = resetDbForTests();
    seed(db, 'leftover', await deadPid(), { status: 'active' });

    await start();

    expect(getSession(db, 'leftover')?.status).toBe('terminated');
  });

  it('sessionSweepMs: 0 turns it off', async () => {
    const db = resetDbForTests();
    seed(db, 'kept', await deadPid(), { status: 'active' });

    await start(0);

    expect(getSession(db, 'kept')?.status).toBe('active');
  });
});
