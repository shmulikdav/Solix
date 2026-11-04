import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { portInUseMessage, probeSolix, stop, type StopDeps } from './stop.js';

/**
 * CLAIM-UPGRADE-NAMES-THE-RUNNING-SERVER. A second `solix` on a busy port says
 * which Solix holds it (version, pid) and how to replace it, and `solix stop`
 * stops only a server that answered as Solix.
 *
 * Measured on 2026-11-03 while upgrading: the old server kept running, the
 * new `solix` said only "port 4242 is already in use", and the browser kept
 * showing the old version, without the security fixes just installed.
 */
describe('the port-in-use message', () => {
  it('names the running version and pid, and how to replace it when versions differ', () => {
    const m = portInUseMessage(4242, { version: '1.20.3', pid: 4711 }, '1.20.4');
    expect(m).toContain('Solix 1.20.3 is already running on port 4242 (pid 4711)');
    expect(m).toContain('this is 1.20.4');
    expect(m).toContain('solix stop && solix');
  });

  it('carries --port through when it is not the default', () => {
    expect(portInUseMessage(5000, { version: '1.0.0', pid: 1 }, '2.0.0')).toContain('solix stop --port 5000 && solix --port 5000');
  });

  it('for the same version, offers to open it', () => {
    const m = portInUseMessage(4242, { version: '1.20.4', pid: 9 }, '1.20.4');
    expect(m).toContain('Open http://127.0.0.1:4242');
    expect(m).not.toContain('this is');
  });

  it('for something that is not Solix, says so and suggests another port', () => {
    expect(portInUseMessage(4242, null, '1.20.4')).toMatch(/not Solix.*--port 4243/s);
  });
});

function fakeDeps(over: Partial<StopDeps> & { running?: boolean[] }): StopDeps & { killed: number[]; lines: string[] } {
  const answers = over.running ?? [true, false];
  let i = 0;
  const killed: number[] = [];
  const lines: string[] = [];
  return {
    probe: async () => (answers[Math.min(i++, answers.length - 1)] ? { version: '1.20.3', pid: 4711 } : null),
    pidListeningOn: () => undefined,
    kill: (pid) => void killed.push(pid),
    sleep: async () => {},
    log: (l) => void lines.push(l),
    ...over,
    killed,
    lines,
  };
}

describe('solix stop (logic)', () => {
  it('signals the pid Solix reported, then confirms it stopped', async () => {
    const d = fakeDeps({});
    expect(await stop({ port: 4242 }, d)).toBe(0);
    expect(d.killed).toEqual([4711]);
    expect(d.lines.join('\n')).toMatch(/stopped Solix 1.20.3 \(pid 4711\)/);
  });

  it('never signals something that did not answer as Solix', async () => {
    const d = fakeDeps({ running: [false], pidListeningOn: () => 999 });
    expect(await stop({ port: 4242 }, d)).toBe(1);
    expect(d.killed).toEqual([]);
    expect(d.lines.join('\n')).toMatch(/pid 999, which is not Solix/);
  });

  it('with nothing on the port, says so and succeeds', async () => {
    const d = fakeDeps({ running: [false] });
    expect(await stop({ port: 4242 }, d)).toBe(0);
    expect(d.killed).toEqual([]);
  });

  it('reports a server that did not stop', async () => {
    const d = fakeDeps({ running: [true] });
    expect(await stop({ port: 4242 }, d)).toBe(1);
    expect(d.lines.join('\n')).toMatch(/still answering/);
  });
});

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
});

function freePort(): Promise<number> {
  return new Promise((done) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => done(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

describe.skipIf(!existsSync(CLI))('solix stop and the port message, end to end against a real server', () => {
  it('a second solix names the running one; solix stop stops it', async () => {
    const port = await freePort();
    const env = { ...process.env, SOLIX_HOME: mkdtempSync(join(tmpdir(), 'solix-stop-')), SOLIX_DISABLE_AGENTVIEW: '1' };
    const server = spawn(process.execPath, [CLI, 'start', '--headless', '--no-wire', '--port', String(port)], { env, stdio: 'ignore' });
    children.push(server);
    let running = null;
    for (let i = 0; i < 80 && !running; i++) {
      await new Promise((r) => setTimeout(r, 150));
      running = await probeSolix(port);
    }
    expect(running?.pid).toBe(server.pid);

    const second = spawnSync(process.execPath, [CLI, 'start', '--headless', '--no-wire', '--port', String(port)], { env, encoding: 'utf8', timeout: 20_000 });
    expect(second.stderr).toContain(`is already running on port ${port} (pid ${server.pid})`);

    const stopped = spawnSync(process.execPath, [CLI, 'stop', '--port', String(port)], { env, encoding: 'utf8', timeout: 20_000 });
    expect(stopped.status).toBe(0);
    expect(stopped.stdout).toContain(`(pid ${server.pid})`);
    expect(await probeSolix(port)).toBeNull();
  }, 40_000);
});
