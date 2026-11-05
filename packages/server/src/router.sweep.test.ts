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

  it('retires a session left by a process that ended before Solix started, and says so', async () => {
    const db = resetDbForTests();
    seed(db, 'leftover', await deadPid(), { status: 'active' });
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void logged.push(a.join(' ')));

    await start();
    spy.mockRestore();

    expect(getSession(db, 'leftover')?.status).toBe('terminated');
    expect(logged.join('\n')).toContain('retired 1 session whose claude process had ended');
  });

  it('sessionSweepMs: 0 turns it off', async () => {
    const db = resetDbForTests();
    seed(db, 'kept', await deadPid(), { status: 'active' });

    await start(0);

    expect(getSession(db, 'kept')?.status).toBe('active');
  });
});

/**
 * CLAIM-DEAD-SESSIONS-RETIRE · "alive at the pid" is not "alive as the agent".
 *
 * Measured on 2026-11-05 on the owner's machine after 1.20.4: of the 8
 * sessions still counted, one pid was a running `claude`. Four belonged to
 * other programs (system services, the Dock, another app) because macOS had
 * reused the numbers. One was a login shell. One was 1 (launchd), and one was 0.
 */
describe('CLAIM-DEAD-SESSIONS-RETIRE: a reused pid does not keep a session alive', () => {
  let db: DB;
  let router: EventRouter;

  beforeEach(() => {
    db = resetDbForTests();
    const broadcaster = new Broadcaster();
    vi.spyOn(broadcaster, 'broadcast').mockImplementation(() => {});
    router = new EventRouter(db, broadcaster);
  });
  afterEach(() => {
    for (const c of children.splice(0)) c.kill('SIGKILL');
  });

  it('reads who holds a pid from the real process table', async () => {
    const { readProcIdentities } = await import('./state/sessions.js');
    const proc = liveProcess();
    const id = readProcIdentities([proc.pid!]).get(proc.pid!);
    expect(id?.comm).toMatch(/sleep$/);
    expect(Math.abs(id!.startSec - Date.now() / 1000)).toBeLessThan(5);
    expect(readProcIdentities([await deadPid()]).size).toBe(0);
  });

  it('retires a session whose pid now belongs to a process started after the session was last heard from', () => {
    // No record from this run (Solix restarted): the pid is alive, but the
    // program at it started an hour after the session's last event, so it
    // cannot be the agent that sent that event.
    const proc = liveProcess();
    seed(db, 'reused', proc.pid!, { status: 'idle', updatedAt: Date.now() - 3600_000 });

    expect(router.sweepDeadSessions()).toEqual(['reused']);
  });

  it('keeps a session whose pid is held by a process that started before its last event', () => {
    const proc = liveProcess();
    seed(db, 'same', proc.pid!, { status: 'active', updatedAt: Date.now() + 5_000 });

    expect(router.sweepDeadSessions()).toEqual([]);
  });

  it('with a record from its events: a different program at the pid means reuse', () => {
    const proc = liveProcess();
    seed(db, 's', proc.pid!, { status: 'idle' });
    router.handleHookEvent(event('s', proc.pid!));

    // The same pid, now held by something else.
    const dock = () => new Map([[proc.pid!, { startSec: Date.now() / 1000 - 1, comm: '/System/Library/CoreServices/Dock.app/Contents/XPCServices/DockHelper' }]]);
    expect(router.sweepDeadSessions(undefined, dock)).toEqual(['s']);
  });

  it('with a record: the same program started at the same time is the same process', () => {
    const proc = liveProcess();
    seed(db, 's', proc.pid!, { status: 'idle', updatedAt: Date.now() - 3600_000 });
    router.handleHookEvent(event('s', proc.pid!));

    expect(router.sweepDeadSessions()).toEqual([]);
  });

  it('a shell at the pid while events arrive is not the agent, so the session is never judged by it', async () => {
    const shell = spawn('bash', ['-c', 'sleep 30; true'], { stdio: 'ignore' });
    children.push(shell);
    await new Promise((r) => setTimeout(r, 100));
    seed(db, 'via-shell', shell.pid!, { status: 'idle' });
    router.handleHookEvent(event('via-shell', shell.pid!));

    await new Promise<void>((done) => {
      shell.once('exit', () => done());
      shell.kill('SIGKILL');
    });
    expect(router.sweepDeadSessions()).toEqual([]);
  });

  it('pid 1 (init: the hook reported a parent that had already exited) is never judged', () => {
    seed(db, 'orphan', 1, { status: 'idle', updatedAt: Date.now() - 3600_000 });
    expect(router.sweepDeadSessions()).toEqual([]);
  });
});
