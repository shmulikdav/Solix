import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

/**
 * `solix demo` is the first thing a new reader runs — the brief says "nothing
 * to look at yet? `solix demo` seeds a full galaxy" — and 913 lines of it had
 * no test. Its own comments record one defect already shipped: it printed
 * "seed complete: 30 sessions across 8 projects" on a clean machine while
 * seeding nothing, because every POST came back 401 and nobody read the
 * response.
 *
 * That is the shape these tests are for. A demo that reports work it did not
 * do is the same defect as a gate that reports a hold it did not make, and it
 * lands on the one path where a stranger is watching.
 *
 * The sandbox server is faked rather than booted: the thing under test is the
 * orchestration — which port, which token, what is claimed afterwards — and a
 * real server would test better-sqlite3 instead.
 */

const hoisted = vi.hoisted(() => ({
  onSpawn: null as null | ((cmd: string, args: string[]) => unknown),
  spawnOpts: [] as { cmd: string; args: string[]; opts: Record<string, unknown> }[],
}));

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (cmd: string, args: string[] = [], opts?: unknown) => {
      hoisted.spawnOpts.push({
        cmd,
        args,
        opts: (opts ?? {}) as Record<string, unknown>,
      });
      const faked = hoisted.onSpawn?.(cmd, args);
      if (faked) return faked;
      return (actual.spawn as (...a: unknown[]) => unknown)(cmd, args, opts);
    },
  };
});

let home: string;
let logs: string[];
let errs: string[];
const servers: Server[] = [];
const strays: import('node:child_process').ChildProcess[] = [];

async function load() {
  vi.resetModules();
  return import('./demo.js');
}

/** A free high port, plus the one after it, so the fallback path is reachable. */
function freePortPair(): number {
  return 39_000 + Math.floor(Math.random() * 2_000) * 2;
}

/** Something listening that is not a Solix sandbox and has no pid on file. */
async function listenForeign(port: number): Promise<void> {
  const s = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
}

/**
 * A real child process holding the port, with its pid recorded where the
 * reaper looks — i.e. exactly a sandbox left behind by a crashed `solix demo`.
 */
async function listenStaleSandbox(port: number): Promise<number> {
  const { spawn } = await import('node:child_process');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `require('node:http').createServer((q,s)=>{s.writeHead(200);s.end('{}')}).listen(${port},'127.0.0.1')`,
    ],
    { stdio: 'ignore' },
  );
  strays.push(child);
  mkdirSync(join(home, '.solix'), { recursive: true });
  writeFileSync(join(home, '.solix', 'demo.pid'), `${child.pid}\n`);
  // Wait for it to actually bind, or the test proves nothing.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(200),
      });
      return child.pid!;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('stale sandbox never came up');
}

interface FakeServer {
  events: { token: string | undefined; body: Record<string, unknown> }[];
  posts: string[];
  /** Reject /events with this status instead of accepting it. */
  rejectEvents: number | null;
  port: number;
}

/**
 * Stands in for the server `solix demo` spawns. It enforces the same
 * `x-solix-token` gate on /events that a real install does, which is the
 * whole reason the seeded-nothing bug existed, and it writes the token file
 * when it "boots" — after this module was loaded, as the real one does.
 */
async function fakeSandbox(port: number): Promise<FakeServer> {
  const state: FakeServer = { events: [], posts: [], rejectEvents: null, port };
  const token = 'tok-written-at-boot';
  mkdirSync(join(home, '.solix'), { recursive: true });
  writeFileSync(join(home, '.solix', 'token'), `${token}\n`);

  const s = createServer((req, res) => {
    const url = req.url ?? '';
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url === '/api/health') return json(200, { ok: true });
    if (url === '/api/advisors') return json(200, [{ id: 'argus', codename: 'Argus' }]);

    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (url === '/events') {
        if (state.rejectEvents) return json(state.rejectEvents, { error: 'nope' });
        state.events.push({
          token: req.headers['x-solix-token'] as string | undefined,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        });
        return json(200, { ok: true });
      }
      state.posts.push(url);
      json(200, { ok: true });
    });
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(port, '127.0.0.1', () => r()));
  return state;
}

interface FakeChild {
  pid: number;
  exitCode: null;
  signalCode: null;
  unrefs: number;
  kills: string[];
  on: () => FakeChild;
  unref: () => void;
  kill: (sig?: number | NodeJS.Signals) => boolean;
}

function fakeChild(pid = 4_242_42): FakeChild {
  const c: FakeChild = {
    pid,
    exitCode: null,
    signalCode: null,
    unrefs: 0,
    kills: [],
    on: () => c,
    unref: () => {
      c.unrefs += 1;
    },
    kill: (sig: number | NodeJS.Signals = 'SIGTERM') => {
      c.kills.push(String(sig));
      return true;
    },
  };
  return c;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solix-demo-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('SOLIX_HOME', join(home, '.solix'));
  logs = [];
  errs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void errs.push(a.join(' ')));
  hoisted.onSpawn = null;
  hoisted.spawnOpts = [];
  process.exitCode = undefined;
});

afterEach(async () => {
  hoisted.onSpawn = null;
  for (const c of strays.splice(0)) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const s of servers.splice(0)) {
    await new Promise<void>((r) => s.close(() => r()));
  }
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('chooseSandboxPort', () => {
  it('takes the port it was asked for when nothing is listening', async () => {
    const { chooseSandboxPort } = await load();
    const port = freePortPair();
    expect(await chooseSandboxPort(port)).toBe(port);
  });

  it('reaps a sandbox left by a crashed run and keeps the asked-for port', async () => {
    // The reaper's own comment: "Without this, orphaned servers accumulate and
    // hold the port + sandbox DB, and every later `solix demo` fails to
    // start." That only holds if the reaping happens before the port is
    // chosen — otherwise the demo quietly moves to the next port to avoid a
    // server it is about to kill, and the default port stays abandoned.
    const { chooseSandboxPort } = await load();
    const port = freePortPair();
    const pid = await listenStaleSandbox(port);

    expect(await chooseSandboxPort(port)).toBe(port);
    expect(() => process.kill(pid, 0)).toThrow(); // reaped, not stepped around
  });

  it('is not stuck when both ports are held by sandboxes it left behind', async () => {
    // The failure this reaper exists to prevent, reproduced exactly: two
    // orphans and `solix demo` telling you to go kill them yourself.
    const { chooseSandboxPort } = await load();
    const port = freePortPair();
    const a = await listenStaleSandbox(port);
    const b = await listenStaleSandbox(port + 1);
    writeFileSync(join(home, '.solix', 'demo.pid'), `${a}\n${b}\n`);

    expect(await chooseSandboxPort(port)).toBe(port);
    expect(() => process.kill(a, 0)).toThrow();
    expect(() => process.kill(b, 0)).toThrow();
  });

  it('steps aside for a server it does not own, rather than killing it', async () => {
    // A real `solix start` on 4242 is not ours to reap.
    const { chooseSandboxPort } = await load();
    const port = freePortPair();
    await listenForeign(port);
    expect(await chooseSandboxPort(port)).toBe(port + 1);
    expect(logs.join('\n')).toMatch(/falling back to/);
  });

  it('gives up with an actionable message when both ports belong to someone else', async () => {
    const { chooseSandboxPort } = await load();
    const port = freePortPair();
    await listenForeign(port);
    await listenForeign(port + 1);
    expect(await chooseSandboxPort(port)).toBeNull();
    expect(errs.join('\n')).toMatch(/both .* are in use/);
  });

  it('survives a corrupt pid file and clears it', async () => {
    const { chooseSandboxPort } = await load();
    mkdirSync(join(home, '.solix'), { recursive: true });
    writeFileSync(join(home, '.solix', 'demo.pid'), 'not-a-pid\n-1\n\n');
    const port = freePortPair();
    expect(await chooseSandboxPort(port)).toBe(port);
    expect(existsSync(join(home, '.solix', 'demo.pid'))).toBe(false);
  });
});

describe('CLAIM-DEMO-SEEDS-OR-SAYS · demoCmd', () => {
  /** Boot the fake sandbox in place of the real spawn, and hand back both. */
  async function withFakeSandbox(port: number) {
    const child = fakeChild();
    let server: FakeServer | null = null;
    const booted = new Promise<FakeServer>((resolve) => {
      hoisted.onSpawn = (_cmd, args) => {
        if (!args.includes('start')) return fakeChild(999); // the browser opener
        void fakeSandbox(port).then((s) => {
          server = s;
          resolve(s);
        });
        return child;
      };
    });
    return { child, booted, get server() { return server; } };
  }

  it('seeds with the token the server wrote after boot, not the one that existed before', async () => {
    // The seeded-nothing bug: the token was read at module load, before the
    // spawned server had created it, so every POST came back 401. Reading it
    // after boot is the fix, and this is what fails if it moves back.
    const { demoCmd } = await load();
    const port = freePortPair();
    const fake = await withFakeSandbox(port);

    const run = demoCmd({ port, noTicker: true, cwd: join(home, 'demo-projects') });
    const server = await fake.booted;
    await run;

    expect(server.events.length).toBeGreaterThan(30);
    expect(new Set(server.events.map((e) => e.token))).toEqual(
      new Set(['tok-written-at-boot']),
    );
  });

  it('creates exactly the galaxy it planned, with no extra planet for the preflight', async () => {
    // The preflight posted `demo-preflight` under the demo root, which landed
    // as a 31st session in a 9th project while the summary said "30 sessions
    // across 8 projects".
    const { demoCmd, planSessions } = await load();
    const port = freePortPair();
    const fake = await withFakeSandbox(port);
    const cwd = join(home, 'demo-projects');

    const run = demoCmd({ port, noTicker: true, cwd });
    const server = await fake.booted;
    await run;

    const started = new Set(
      server.events
        .filter((e) => e.body.event === 'session_start')
        .map((e) => (e.body.payload as { session_id: string }).session_id),
    );
    expect(started).toEqual(new Set(planSessions(cwd).map((s) => s.id)));

    const dirs = new Set(server.events.map((e) => e.body.cwd as string));
    expect(dirs).toEqual(new Set(planSessions(cwd).map((s) => s.cwd)));
  });

  it('refuses to claim a seed when the very first event is rejected', async () => {
    const { demoCmd } = await load();
    const port = freePortPair();
    const child = fakeChild();
    hoisted.onSpawn = (_cmd, args) => {
      if (!args.includes('start')) return fakeChild(999);
      void fakeSandbox(port).then((s) => {
        s.rejectEvents = 401;
      });
      return child;
    };

    await demoCmd({ port, noTicker: true });

    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/nothing\n?\s*was seeded/);
    expect(logs.join('\n')).not.toMatch(/seed complete/);
  });

  it('says how many seed writes were rejected instead of claiming the galaxy', async () => {
    // The preflight event catches a server that rejects everything. It does
    // not catch one that starts rejecting after it — and the seeder discarded
    // every result, so "seed complete: 30 sessions across 8 projects" printed
    // over a seed that mostly failed. postEvent's own comment claims "the
    // ticker ignores it; the seeder does not."
    const { demoCmd } = await load();
    const port = freePortPair();
    const fake = await withFakeSandbox(port);

    const run = demoCmd({ port, noTicker: true });
    const server = await fake.booted;
    // Let the preflight through, then fail everything after it.
    server.rejectEvents = null;
    const stop = setInterval(() => {
      if (server.events.length >= 1) {
        server.rejectEvents = 503;
        clearInterval(stop);
      }
    }, 5);
    await run;
    clearInterval(stop);

    expect(errs.join('\n')).toMatch(/rejected/);
    expect(process.exitCode).toBe(1);
  });

  it('derives the status mix it reports from the plan it seeded', async () => {
    // It was a hardcoded sentence — "5 active, 18 idle, 3 awaiting_permission
    // …" — printed whatever the plan actually contained. A summary that is a
    // string literal is a claim with nothing behind it.
    const { demoCmd, STATUS_PLAN } = await load();
    const port = freePortPair();
    const fake = await withFakeSandbox(port);

    // Change the plan. Asserting against the plan as it stands proves
    // nothing — the literal it replaced happened to be *correct* for today's
    // mix, so a test that only checked agreement passed with the hardcoded
    // sentence reinstated. The property is that the summary follows the plan,
    // which is only visible when the plan moves.
    STATUS_PLAN.push('error', 'error', 'plan_review');

    const run = demoCmd({ port, noTicker: true });
    await fake.booted;
    await run;

    const line = logs.find((l) => l.includes('status mix'));
    expect(line).toBeTruthy();
    const counts = new Map<string, number>();
    for (const s of STATUS_PLAN) counts.set(s, (counts.get(s) ?? 0) + 1);
    expect(counts.get('error')).toBe(3);
    for (const [status, n] of counts) {
      expect(line, status).toContain(`${n} ${status}`);
    }
    // And the session count is the plan's, not a number of its own.
    expect(logs.join('\n')).toContain(`${STATUS_PLAN.length} sessions`);
  });

  it('releases the sandbox on --no-ticker so the command can actually exit', async () => {
    // `--no-ticker` is documented as "seed once and exit (static snapshot for
    // screenshots)", and docs/CAPTURE.md tells you to use it. It never
    // exited: a live child keeps the parent's event loop open, so the command
    // printed "Exiting." and hung — and the only way out, Ctrl+C, reached the
    // child through the shared process group and killed the sandbox you were
    // about to screenshot.
    const { demoCmd } = await load();
    const port = freePortPair();
    const fake = await withFakeSandbox(port);

    const run = demoCmd({ port, noTicker: true });
    await fake.booted;
    await run;

    expect(fake.child.unrefs).toBeGreaterThan(0);
    expect(fake.child.kills).toEqual([]); // the snapshot server must survive

    // Releasing the event loop is not enough. The orphaned server also has to
    // stop holding the command's stdout, or a shell pipeline never sees EOF
    // and `solix demo --no-ticker | tee shot.log` hangs exactly as before —
    // which is what happened when `unref()` alone was called the fix, and only
    // showed up on a real run.
    const boot = hoisted.spawnOpts.find((s) => s.args.includes('start'));
    expect(boot, 'the sandbox was never spawned').toBeTruthy();
    expect(boot!.opts.detached, 'snapshot server shares the process group').toBe(
      true,
    );
    const stdio = boot!.opts.stdio as unknown[];
    expect(stdio[1], 'snapshot server still holds the terminal').not.toBe(
      'inherit',
    );
    expect(logs.join('\n')).toMatch(/logging to .*demo-server\.log/);
  });

  it('does not spawn anything when --no-server has nothing to attach to', async () => {
    const { demoCmd } = await load();
    let spawned = 0;
    hoisted.onSpawn = () => {
      spawned += 1;
      return fakeChild();
    };
    await demoCmd({ port: freePortPair(), noServer: true, noTicker: true });
    expect(spawned).toBe(0);
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/nothing is listening/);
  });
});

describe('CLAIM-DEMO-SEEDS-OR-SAYS · tearDownSandbox', () => {
  function sandboxFiles(): string[] {
    return [
      join(home, '.solix', 'demo.db'),
      join(home, '.solix', 'demo.db-shm'),
      join(home, '.solix', 'demo.db-wal'),
      join(home, '.solix', 'demo.pid'),
    ];
  }

  function writeSandbox(): void {
    mkdirSync(join(home, '.solix'), { recursive: true });
    for (const f of sandboxFiles()) writeFileSync(f, 'x');
  }

  it('kills the sandbox and removes its database', async () => {
    // "`solix demo` seeds a sandbox and cleans up after itself" was a claim
    // with nothing behind it. The DB matters: it is the thing that squats and
    // makes the next run behave strangely.
    const { tearDownSandbox } = await load();
    writeSandbox();
    const child = fakeChild();
    let stopped = 0;

    await tearDownSandbox({ child, stopTicker: () => void (stopped += 1), keep: false });

    expect(stopped).toBe(1);
    expect(child.kills[0]).toBe('SIGTERM');
    for (const f of sandboxFiles()) expect(existsSync(f), f).toBe(false);
    expect(logs.join('\n')).toMatch(/cleaned up/);
  });

  it('keeps every sandbox file when --keep was passed', async () => {
    const { tearDownSandbox } = await load();
    writeSandbox();

    await tearDownSandbox({ child: fakeChild(), stopTicker: null, keep: true });

    for (const f of sandboxFiles()) expect(existsSync(f), f).toBe(true);
    expect(logs.join('\n')).toMatch(/preserved/);
  });

  it('tears down cleanly when there is no child and nothing on disk', async () => {
    const { tearDownSandbox } = await load();
    await expect(
      tearDownSandbox({ child: null, stopTicker: null, keep: false }),
    ).resolves.toBeUndefined();
  });
});
