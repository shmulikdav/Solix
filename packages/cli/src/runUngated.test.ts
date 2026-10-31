import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * CLAIM-RUN-UNGATED · `solix run` does not govern the session.
 *
 * It wraps `claude` in a PTY so the browser can type into it. It does not
 * gate it, and it cannot: Solix governs an agent by setting its environment
 * before the process starts, and the gate reaches the hook only through
 * `SOLIX_GATE_ENABLED`. `run.ts` does not set it, so the hook takes its
 * fire-and-forget branch and neither the human gate nor the command
 * denylist is ever consulted.
 *
 * This claim has been published wrongly twice. Once in
 * `docs/PARTNER-BRIEF.md` — "wrap it with `solix run` and it becomes a
 * session Solix launched, denylist included" — caught before it was sent.
 * Once on the home page — "wrap it with `solix run` and it gets the same
 * treatment" — which went live, because the sentence was written in the
 * website repo where nothing could check it against this file.
 *
 * So the assertion is deliberately about the spawn environment rather than
 * about behaviour further downstream. `env` is the entire mechanism; if a
 * future change starts gating `solix run`, this test fails and tells whoever
 * did it to go and update the three places that promise it does not.
 */
const RUN_TS = resolve(import.meta.dirname ?? __dirname, 'run.ts');

describe('CLAIM-RUN-UNGATED', () => {
  const source = readFileSync(RUN_TS, 'utf8');

  it('spawns claude without the gate env, so the hook stays passive', () => {
    // The one spawn in this file, and everything it adds to the inherited
    // environment. Asserting on the source rather than by running a PTY,
    // because a PTY spawn in CI is flaky and the env literal is the whole
    // contract.
    const spawn = source.slice(source.indexOf('pty.spawn('));
    const envLine = spawn.slice(spawn.indexOf('env:'), spawn.indexOf('});'));

    expect(envLine).toContain('SOLIX_WRAPPER_ID');
    expect(envLine).not.toContain('SOLIX_GATE_ENABLED');
    expect(envLine).not.toContain('SOLIX_GATE_POLICY');
    expect(envLine).not.toContain('containmentGateEnv');
    expect(envLine).not.toContain('buildSpawnEnv');
  });

  it('does not import the gate env builders at all', () => {
    // A stronger form of the same thing: if someone wires the gate in here,
    // they almost certainly reach for one of these first.
    expect(source).not.toMatch(/containmentGateEnv|buildSpawnEnv/);
  });

  it('the hook it leaves in place defaults to fail-OPEN', () => {
    // Why the above matters. With SOLIX_GATE_ENABLED unset the hook exits
    // before the policy is even read — but if someone sets GATE_ENABLED here
    // without also setting a policy, the default would wave commands
    // through on an unreachable server. Pinned so that mistake is loud.
    const hook = readFileSync(
      resolve(
        import.meta.dirname ?? __dirname,
        '..',
        'hooks',
        'pre-tool-bash.sh',
      ),
      'utf8',
    );
    expect(hook).toContain('SOLIX_GATE_POLICY="${SOLIX_GATE_POLICY:-fail-open}"');
    expect(hook).toMatch(/if \[ "\$SOLIX_GATE_ENABLED" != "1" \]/);
  });
});
