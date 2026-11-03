import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `solix gate` end to end, minus the real agent: a headless Solix server in
 * process on an isolated home, and a fake agent that speaks the hook protocol
 * (session start, then PreToolUse permission requests) over HTTP — which is
 * exactly what the shipped hook scripts do. A real `claude` is the one thing
 * this cannot exercise (the `--settings` injection); that is a real-machine check.
 * (`CLAIM-HEADLESS-FAILS-CLOSED`)
 */
let home: string;
let project: string;
const logs: string[] = [];

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.on('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      s.close(() => done(port));
    });
  });
}

async function load() {
  vi.resetModules();
  const gateMod = await import('./gate.js');
  const create = await import('@solix/server/create');
  const db = await import('@solix/server/db');
  const report = await import('@solix/server/report');
  return { ...gateMod, ...create, ...db, ...report };
}

type Mods = Awaited<ReturnType<typeof load>>;

/** Deps: the real headless server in process, and a scripted agent. */
function deps(m: Mods, commands: string[], seen: Array<{ command: string; decision: string }>, agentExit = 0) {
  let calls = 0;
  return {
    started: () => calls,
    value: {
      now: () => Date.now(),
      log: (l: string) => void logs.push(l),
      async startServer(h: string) {
        calls += 1;
        expect(h).toBe(home);
        const port = await freePort();
        const handle = await m.createSolixServer({ port, headless: true });
        return {
          port,
          stop: () => handle.close(),
          openDb: () => m.openDbReadonly(join(home, 'solix.db')),
        };
      },
      async runAgent(_cmd: string[], env: NodeJS.ProcessEnv) {
        expect(env.SOLIX_GATE_ENABLED).toBe('1');
        expect(env.SOLIX_GATE_POLICY).toBe('deny');
        const base = `http://127.0.0.1:${env.SOLIX_PORT}`;
        const sid = 'gate-session-1';
        await fetch(`${base}/events`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event: 'session_start', pid: 1, cwd: project, ts: Date.now(), payload: { session_id: sid, cwd: project } }),
        });
        for (const command of commands) {
          const res = await fetch(`${base}/events/permission`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              event: 'pre_tool_bash',
              pid: 1,
              cwd: project,
              ts: Date.now(),
              payload: { session_id: sid, tool_name: 'Bash', tool_input: { command } },
            }),
          });
          const body = (await res.json()) as { decision: string };
          seen.push({ command, decision: body.decision });
        }
        return agentExit;
      },
    },
  };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gate-home-'));
  project = mkdtempSync(join(tmpdir(), 'gate-proj-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('SOLIX_HOME', home);
  vi.stubEnv('SOLIX_DISABLE_AGENTVIEW', '1');
  logs.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('solix gate', () => {
  it('allows what a rule covers, refuses the rest at once, writes a signed artifact, exits 3', async () => {
    const m = await load();
    const seen: Array<{ command: string; decision: string }> = [];
    const out = join(home, 'artifact');
    const d = deps(m, ['ls -la', 'npm publish'], seen);
    const code = await m.gate({ rules: 'defaults', out, home, command: ['claude', '-p', 'x'] }, d.value);

    expect(seen).toEqual([
      { command: 'ls -la', decision: 'allow' },
      { command: 'npm publish', decision: 'deny' },
    ]);
    expect(code).toBe(m.EXIT_REFUSED);
    for (const f of ['report.json', 'report.md', 'audit.json']) expect(existsSync(join(out, f))).toBe(true);
    const audit = JSON.parse(readFileSync(join(out, 'audit.json'), 'utf8')) as Array<{ kind: string; payload: { headless?: boolean } }>;
    expect(audit.some((r) => r.kind === 'permission_auto_denied' && r.payload?.headless)).toBe(true);
    expect(audit.some((r) => r.kind === 'permission_auto_approved')).toBe(true);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(m.verifyReport(report).ok).toBe(true);
    expect(logs.join('\n')).toMatch(/✗ npm publish/);
  });

  it('--allow-denials returns the agent’s own code', async () => {
    const m = await load();
    const d = deps(m, ['npm publish'], []);
    const code = await m.gate(
      { rules: 'defaults', out: join(home, 'a'), home, allowDenials: true, command: ['agent'] },
      d.value,
    );
    expect(code).toBe(0);
  });

  it('a failing agent’s exit code wins', async () => {
    const m = await load();
    const d = deps(m, ['npm publish'], [], 7);
    expect(await m.gate({ rules: 'defaults', out: join(home, 'a'), home, command: ['agent'] }, d.value)).toBe(7);
  });

  it('a policy that covers everything the agent does exits 0', async () => {
    const m = await load();
    const rules = join(home, 'policy.json');
    writeFileSync(rules, JSON.stringify([{ tool: 'Bash', match: 'command_prefix', value: 'npm publish', decision: 'allow' }]));
    const seen: Array<{ command: string; decision: string }> = [];
    const d = deps(m, ['npm publish'], seen);
    expect(await m.gate({ rules, out: join(home, 'a'), home, command: ['agent'] }, d.value)).toBe(0);
    expect(seen[0]!.decision).toBe('allow');
  });

  it('rejects a bad policy before starting anything', async () => {
    const m = await load();
    const rules = join(home, 'bad.json');
    writeFileSync(rules, JSON.stringify([{ tool: 'Bash', match: 'nonsense' }]));
    const d = deps(m, [], []);
    expect(await m.gate({ rules, out: join(home, 'a'), home, command: ['agent'] }, d.value)).toBe(m.EXIT_GATE_ERROR);
    expect(d.started()).toBe(0);
    expect(logs.join('\n')).toMatch(/policy rejected/);
  });

  it('injects --settings when the agent is claude', async () => {
    const m = await load();
    let ran: string[] = [];
    const d = deps(m, [], []);
    const run = d.value.runAgent;
    d.value.runAgent = async (cmd, env) => {
      ran = cmd;
      return run(cmd, env);
    };
    await m.gate({ rules: 'defaults', out: join(home, 'a'), home, command: ['claude', '-p', 'hi'] }, d.value);
    expect(ran.slice(0, 3)).toEqual(['claude', '--settings', join(home, 'gate-settings.json')]);
    const settings = JSON.parse(readFileSync(join(home, 'gate-settings.json'), 'utf8'));
    expect(JSON.stringify(settings.hooks.PreToolUse)).toContain(join(home, 'hooks', 'pre-tool-bash.sh'));
  });
});

describe('docs/GATE.md', () => {
  // The doc's example policy is what people will copy. If it stops parsing,
  // the doc is wrong, so it is a test failure, not a support ticket.
  it('its example policy is a valid gate policy', async () => {
    const m = await load();
    const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../docs/GATE.md'), 'utf8');
    const json = /```json\n([\s\S]*?)```/.exec(doc)![1]!;
    const file = join(home, 'doc-policy.json');
    writeFileSync(file, json);
    const res = m.loadPolicy(file);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.rules).toHaveLength(5);
  });
});
