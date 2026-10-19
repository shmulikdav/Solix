import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { Launcher, resetAgentCapsForTests, resolveAgentBin } from './launcher.js';

/**
 * End-to-end launcher test against a REAL subprocess.
 *
 * Every other orchestrator test injects a fake SessionRunner, which means the
 * actual spawn path — capability probe, argv construction, env scrub + gate
 * injection, granted-secret merge, stdout capture, JSON envelope parsing, cost
 * extraction, exit-code mapping, SIGTERM on abort — was only ever validated
 * against a fake that returned whatever the parser expected. That's circular.
 *
 * Here SOLIX_CLAUDE_BIN points at a stand-in executable, so the whole chain
 * runs for real. It can't prove the real `claude` emits this envelope (only a
 * live smoke test can), but it does prove every other link works, and pins the
 * CLI contract Solix depends on.
 */
const STUB = resolve('packages/server/src/__fixtures__/stub-agent.mjs');

interface Probe {
  args: string[];
  cwd: string;
  env: Record<string, string | null>;
}

describe('Launcher.runOnce against a real stand-in process', () => {
  let db: DB;
  let launcher: Launcher;
  let workdir: string;
  let probeFile: string;

  beforeAll(() => {
    // realpath, because on macOS tmpdir() is /var/... which is a symlink to
    // /private/var/... — the child process reports the resolved path, so an
    // unresolved workdir makes the "it ran where we asked" assertion fail
    // there while passing on Linux.
    workdir = realpathSync(mkdtempSync(join(tmpdir(), 'solix-launch-')));
    probeFile = join(workdir, 'probe.json');
    process.env.SOLIX_CLAUDE_BIN = STUB;
    process.env.STUB_PROBE_FILE = probeFile;
    // The stub's control vars aren't on the contained-worker allowlist (the
    // scrub correctly drops them), so let them through the documented escape
    // hatch. This also exercises SOLIX_ENV_PASSTHROUGH itself.
    process.env.SOLIX_ENV_PASSTHROUGH = 'STUB_MODE,STUB_PROBE_FILE';
    // An ambient var that is NOT a granted secret — must be scrubbed from a
    // contained worker's env.
    process.env.AMBIENT_NOT_GRANTED = 'should-not-reach-the-worker';
    resetAgentCapsForTests(); // re-probe --help against the stub
    db = resetDbForTests();
    launcher = new Launcher(db, new Broadcaster());
  });

  afterAll(() => {
    delete process.env.SOLIX_CLAUDE_BIN;
    delete process.env.STUB_PROBE_FILE;
    delete process.env.AMBIENT_NOT_GRANTED;
    delete process.env.STUB_MODE;
    delete process.env.SOLIX_ENV_PASSTHROUGH;
    resetAgentCapsForTests();
    rmSync(workdir, { recursive: true, force: true });
  });

  it('honors the binary override', () => {
    expect(resolveAgentBin('claude')).toBe(STUB);
    // Unset falls back to the runtime name.
    const saved = process.env.SOLIX_CODEX_BIN;
    delete process.env.SOLIX_CODEX_BIN;
    expect(resolveAgentBin('codex')).toBe('codex');
    if (saved !== undefined) process.env.SOLIX_CODEX_BIN = saved;
  });

  it('runs, parses the envelope, and extracts the real cost', async () => {
    delete process.env.STUB_MODE;
    const sessionId = randomUUID();
    const run = await launcher.runOnce({
      cwd: workdir,
      prompt: 'do the thing',
      model: 'haiku',
      sessionId,
      contain: true,
      env: { GRANTED_TOKEN: 'granted-value' },
    });

    expect(run.ok).toBe(true);
    expect(run.output).toBe('STUB_WORKER_OUTPUT');
    // The cost that drives every budget gate — parsed from a real process.
    expect(run.costUsd).toBeCloseTo(0.0425, 6);

    const probe = JSON.parse(readFileSync(probeFile, 'utf8')) as Probe;
    // The capability probe worked: both correlation/cost flags were passed.
    // (If --help parsing had failed, these would be absent.)
    expect(probe.args).toContain('--print');
    expect(probe.args).toContain('--output-format');
    expect(probe.args).toContain('json');
    expect(probe.args).toContain('--session-id');
    expect(probe.args).toContain(sessionId); // correlation id actually reached the child
    expect(probe.args).toContain('--model');
    expect(probe.args).toContain('haiku');
    expect(probe.args[probe.args.length - 1]).toBe('do the thing');
    // It ran in the requested directory.
    expect(probe.cwd).toBe(workdir);
  });

  it('injects the containment gate and ONLY granted secrets into a real child env', () => {
    const probe = JSON.parse(readFileSync(probeFile, 'utf8')) as Probe;
    // Safe-by-default gate reached the process.
    expect(probe.env.SOLIX_GATE_ENABLED).toBe('1');
    expect(probe.env.SOLIX_GATE_POLICY).toBe('deny');
    // Least privilege, verified through a real spawn: the granted secret is
    // present, an ambient non-granted var is scrubbed away.
    expect(probe.env.GRANTED_TOKEN).toBe('granted-value');
    expect(probe.env.AMBIENT_NOT_GRANTED).toBeNull();
  });

  it('maps an is_error envelope to a failed run', async () => {
    process.env.STUB_MODE = 'error_envelope';
    const run = await launcher.runOnce({ cwd: workdir, prompt: 'p', contain: true });
    expect(run.ok).toBe(false);
    expect(run.error).toBeTruthy();
    delete process.env.STUB_MODE;
  });

  it('maps a non-zero exit to a failed run carrying stderr', async () => {
    process.env.STUB_MODE = 'fail';
    const run = await launcher.runOnce({ cwd: workdir, prompt: 'p', contain: true });
    expect(run.ok).toBe(false);
    expect(run.error).toContain('exploded');
    delete process.env.STUB_MODE;
  });

  it('surfaces the reason from a failure arm that carries errors[] and no result', async () => {
    process.env.STUB_MODE = 'error_arm';
    const run = await launcher.runOnce({ cwd: workdir, prompt: 'p', contain: true });
    expect(run.ok).toBe(false);
    // The model's own reason reaches the caller (and so the retry prompt),
    // rather than a generic "reported an error".
    expect(run.error).toContain('turn limit');
    // Cost is still banked even on a failed run — it was really spent.
    expect(run.costUsd).toBeCloseTo(0.31, 6);
    delete process.env.STUB_MODE;
  });

  it('falls back to raw stdout when the output is not an envelope', async () => {
    process.env.STUB_MODE = 'not_json';
    const run = await launcher.runOnce({ cwd: workdir, prompt: 'p', contain: true });
    // Exit 0 with unparseable stdout → still a success, raw text returned.
    expect(run.ok).toBe(true);
    expect(run.output).toContain('plain text');
    expect(run.costUsd).toBeUndefined();
    delete process.env.STUB_MODE;
  });

  it('aborts a hung process via the kill-switch', async () => {
    process.env.STUB_MODE = 'hang';
    const ac = new AbortController();
    const pending = launcher.runOnce({
      cwd: workdir,
      prompt: 'p',
      contain: true,
      signal: ac.signal,
    });
    // Let it actually spawn, then fire the kill-switch.
    await new Promise((r) => setTimeout(r, 150));
    ac.abort();
    const run = await pending;
    expect(run.ok).toBe(false);
    expect(run.error).toBe('aborted');
    delete process.env.STUB_MODE;
  }, 15000);

  it('refuses to spawn when already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const run = await launcher.runOnce({ cwd: workdir, prompt: 'p', signal: ac.signal });
    expect(run.ok).toBe(false);
    expect(run.error).toBe('aborted');
  });
});
