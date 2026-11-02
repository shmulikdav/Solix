import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Contract test for `scripts/probe-codex-gate.sh`, run as a subprocess the way
 * `gate.contract.test.ts` runs the shipped hooks.
 *
 * The probe answers one question on a real `codex`: can `PermissionRequest`
 * affirmatively approve? The whole value of the answer rests on the probe
 * sending the shape Codex actually reads — and the first version did not.
 *
 * It sent `permissionDecision: "approve"` on `PermissionRequest`. That is
 * `PreToolUse`'s flat vocabulary plus a value the docs list as
 * parsed-but-unsupported. `PermissionRequest` reads a nested decision object.
 * Every run would have come back unsupported, the conclusion would have been
 * "Codex cannot approve", and `docs/multi-runtime.md` would now record a false
 * negative with clean output behind it.
 *
 * So the load-bearing assertion here is not that the probe works. It is that
 * the probe is aimed at the right field.
 */
const PROBE = resolve('scripts/probe-codex-gate.sh');

interface Run {
  stdout: string;
  status: number | null;
  log: string;
}

function runProbe(
  behavior: string,
  payload: Record<string, unknown>,
  logDir = mkdtempSync(join(tmpdir(), 'codex-probe-')),
): Run {
  const logPath = join(logDir, 'probe.log');
  const r = spawnSync('sh', [PROBE], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: logDir,
      PROBE_BEHAVIOR: behavior,
      PROBE_LOG: logPath,
    },
    timeout: 20_000,
  });
  let log = '';
  try {
    log = readFileSync(logPath, 'utf8');
  } catch {
    /* no log written — asserted on where it matters */
  }
  return { stdout: r.stdout ?? '', status: r.status, log };
}

const permissionRequest = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  turn_id: 't1',
  tool_input: { command: 'rm -rf /tmp/solix-canary' },
};

const preToolUse = {
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'rm -rf /tmp/solix-canary' },
};

describe('codex probe — PermissionRequest', () => {
  /**
   * The one that would have caught the wrong-field bug. Per Codex's hook
   * docs, approval is `decision: { behavior: "allow" }` — not
   * `permissionDecision`.
   */
  it('approves with a nested decision object, not permissionDecision', () => {
    const { stdout } = runProbe('allow', permissionRequest);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    });
    expect(stdout).not.toContain('permissionDecision');
  });

  it('denies with a behavior and a message', () => {
    const { stdout } = runProbe('deny', permissionRequest);
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.decision.behavior).toBe('deny');
    expect(out.decision.message).toBeTruthy();
  });

  /**
   * "Decline to decide and let the normal approval prompt continue." Anything
   * on stdout would be a decision, so silence has to be exact — and run 1 of
   * the run sheet is only interpretable if abstention is really abstention.
   */
  it('abstains in silence', () => {
    const { stdout, status } = runProbe('abstain', permissionRequest);
    expect(stdout.trim()).toBe('');
    expect(status).toBe(0);
  });

  /**
   * The wrong shape, kept on purpose so the run records Codex rejecting it
   * rather than leaving me to assert that it would have.
   */
  it('still sends the wrong legacy shape under PROBE_BEHAVIOR=legacy', () => {
    const { stdout } = runProbe('legacy', permissionRequest);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision).toBe('approve');
  });
});

describe('codex probe — PreToolUse', () => {
  /** Verified against codex-cli 0.166.0: a deny needs a non-empty reason. */
  it('denies with a non-empty reason', () => {
    const { stdout } = runProbe('deny', preToolUse);
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe('deny');
    expect(out.permissionDecisionReason.length).toBeGreaterThan(0);
  });

  /** PreToolUse is deny-only; `allow` is sent so the run records its refusal. */
  it('uses the flat vocabulary here, unlike PermissionRequest', () => {
    const { stdout } = runProbe('allow', preToolUse);
    const out = JSON.parse(stdout).hookSpecificOutput;
    expect(out.permissionDecision).toBe('allow');
    expect(out.decision).toBeUndefined();
  });
});

describe('codex probe — the log is the evidence', () => {
  /**
   * An abstaining hook prints nothing, so without the log a run leaves no
   * trace it happened — indistinguishable from a hook that was never invoked,
   * or one Codex skipped pending trust review. Run 5 of the run sheet turns on
   * being able to tell those apart.
   */
  it('records an abstaining invocation, which prints nothing', () => {
    const { log } = runProbe('abstain', permissionRequest);
    expect(log).toContain('event=PermissionRequest');
    expect(log).toContain('rm -rf /tmp/solix-canary');
    expect(log).toContain('returned: <nothing>');
  });

  it('records the exact bytes returned', () => {
    const { stdout, log } = runProbe('allow', permissionRequest);
    expect(log).toContain(stdout.trim());
  });

  /** A malformed payload must abstain rather than emit a decision. */
  it('abstains and still logs when the payload is not JSON', () => {
    const logDir = mkdtempSync(join(tmpdir(), 'codex-probe-'));
    const logPath = join(logDir, 'probe.log');
    const r = spawnSync('sh', [PROBE], {
      input: 'not json',
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: logDir,
        PROBE_BEHAVIOR: 'deny',
        PROBE_LOG: logPath,
      },
      timeout: 20_000,
    });
    expect(r.stdout?.trim()).toBe('');
    expect(r.status).toBe(0);
    expect(readFileSync(logPath, 'utf8')).toContain('event=<none>');
  });
});

describe('codex probe — self-test', () => {
  /**
   * The probe ships its own `--self-test` so it can be checked on a machine
   * with no Node. If it ever passes vacuously, the assertions above are the
   * only thing left, so its exit code is asserted here too.
   */
  it('passes, and says plainly that it does not prove Codex accepts anything', () => {
    const r = spawnSync('sh', [PROBE, '--self-test'], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('all checks passed');
    expect(r.stdout).toContain('does NOT prove');
  });
});
