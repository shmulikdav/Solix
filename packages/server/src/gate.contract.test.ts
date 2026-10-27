import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { containmentGateEnv } from './launcher.js';

/**
 * Cross-component contract test: the policy value the LAUNCHER injects must be
 * a value the HOOK actually honors.
 *
 * This is the boundary where a real fail-open bug lived. The launcher injected
 * SOLIX_GATE_POLICY=deny; the hook only denied on the literal "fail-closed".
 * Both sides' own tests passed, and the gate failed OPEN whenever the server
 * was unreachable or an approval timed out — exactly what fail-closed exists to
 * prevent. Nothing crossed the boundary, so nothing caught it.
 *
 * These tests run the REAL hook scripts as subprocesses, pointed at a closed
 * port so the gate is unreachable, and assert the decision.
 */
const HOOKS = ['pre-tool-bash', 'pre-tool-file', 'pre-tool-task'] as const;
const HOOK_DIR = 'packages/cli/hooks';

function runHook(
  name: string,
  env: Record<string, string>,
): { stdout: string; status: number | null } {
  const r = spawnSync('sh', [resolve(`${HOOK_DIR}/${name}.sh`)], {
    input: JSON.stringify({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      cwd: '/tmp',
    }),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      SOLIX_HOST: '127.0.0.1',
      SOLIX_PORT: '1', // nothing listening → gate unreachable
      SOLIX_GATE_TIMEOUT: '2',
      ...env,
    },
    timeout: 20000,
  });
  return { stdout: r.stdout ?? '', status: r.status };
}

describe('launcher→hook gate policy contract', () => {
  it.each(HOOKS)(
    '%s fails CLOSED with the policy the launcher actually injects',
    (hook) => {
      // Whatever containmentGateEnv injects is what a worker really gets.
      const injected = containmentGateEnv({});
      expect(injected.SOLIX_GATE_ENABLED).toBe('1');
      const policy = injected.SOLIX_GATE_POLICY!;
      expect(policy).toBeTruthy();

      const { stdout, status } = runHook(hook, {
        SOLIX_GATE_ENABLED: '1',
        SOLIX_GATE_POLICY: policy,
      });

      // A deny must be emitted — not silence (silence = Claude Code proceeds).
      const parsed = JSON.parse(stdout.trim()) as {
        hookSpecificOutput: { hookEventName: string; permissionDecision: string };
      };
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(status).toBe(0);
    },
  );

  it.each(HOOKS)('%s emits ONLY the JSON object on stdout', (hook) => {
    // Claude Code parses the decision only when stdout is exactly one JSON
    // object — stray output (curl noise, profile banners) silently voids it.
    const { stdout } = runHook(hook, {
      SOLIX_GATE_ENABLED: '1',
      SOLIX_GATE_POLICY: containmentGateEnv({}).SOLIX_GATE_POLICY!,
    });
    const trimmed = stdout.trim();
    expect(trimmed.startsWith('{')).toBe(true);
    expect(trimmed.endsWith('}')).toBe(true);
    expect(() => JSON.parse(trimmed)).not.toThrow();
    expect(trimmed.split('\n')).toHaveLength(1);
  });

  it.each(HOOKS)('%s honors an explicit fail-open (defers, no decision)', (hook) => {
    const { stdout, status } = runHook(hook, {
      SOLIX_GATE_ENABLED: '1',
      SOLIX_GATE_POLICY: 'fail-open',
    });
    expect(stdout.trim()).toBe(''); // defer to Claude Code's own flow
    expect(status).toBe(0);
  });

  it.each(HOOKS)('%s in observe mode never blocks and prints nothing', (hook) => {
    const { stdout, status } = runHook(hook, { SOLIX_GATE_ENABLED: '0' });
    expect(stdout.trim()).toBe('');
    expect(status).toBe(0);
  });

  it('accepts the legacy fail-closed spelling too (back-compat)', () => {
    const { stdout } = runHook('pre-tool-bash', {
      SOLIX_GATE_ENABLED: '1',
      SOLIX_GATE_POLICY: 'fail-closed',
    });
    expect(stdout).toContain('"permissionDecision":"deny"');
  });

  /**
   * Every JSON payload these hooks emit is wrapped in SHELL SINGLE QUOTES:
   *
   *     printf '%s\n' '{"hookSpecificOutput":{...}}'
   *
   * so a single apostrophe anywhere inside terminates the string early and
   * the hook emits garbage. That is not theoretical — writing
   * "wastes the reviewer's attention" into a deny reason broke all three
   * hooks at once, and the only symptom was five unrelated tests failing on
   * a JSON parse.
   *
   * This asserts the shape directly, so the next person gets one obvious
   * failure naming the file instead of a parse error three layers away.
   */
  describe('the emitted payloads are shell-safe and valid JSON', () => {
    const PAYLOAD = /printf '%s\\n' '(\{.*?\})'/g;

    it.each(HOOKS)('%s', (hook) => {
      const src = readFileSync(resolve(HOOK_DIR, `${hook}.sh`), 'utf8');
      const payloads = [...src.matchAll(PAYLOAD)].map((m) => m[1]!);
      expect(payloads.length).toBeGreaterThan(0);

      for (const raw of payloads) {
        // A single quote here would have ended the shell string already.
        expect(raw).not.toContain("'");
        expect(() => JSON.parse(raw)).not.toThrow();
        const parsed = JSON.parse(raw) as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        };
        expect(parsed.hookSpecificOutput?.permissionDecision).toMatch(/^(allow|deny)$/);
        expect(parsed.hookSpecificOutput?.permissionDecisionReason ?? '').not.toBe('');
      }
    });
  });
});
