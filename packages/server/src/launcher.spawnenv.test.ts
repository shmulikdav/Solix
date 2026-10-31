import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnCalls: { file: string; opts: { env?: NodeJS.ProcessEnv } }[] = [];

// Intercept the real spawn so we can read the env a child would be handed.
vi.mock('node:child_process', async () => {
  const actual =
    await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (file: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      spawnCalls.push({ file, opts });
      return {
        pid: 4242,
        stdout: { setEncoding: () => ({ on: () => undefined }), on: () => undefined },
        stderr: { setEncoding: () => ({ on: () => undefined }), on: () => undefined },
        on: () => undefined,
        kill: () => true,
      };
    },
  };
});

const { resetDbForTests } = await import('./db.js');
const { Broadcaster } = await import('./broadcaster.js');
const { Launcher } = await import('./launcher.js');
const { setGovernanceLevel } = await import('./state/governance.js');

import type { DB } from './db.js';

/**
 * Does the process we actually spawn carry the gate?
 *
 * `launcher.gate.test.ts` proves the env *builder* is right, and the New task
 * tests prove the Agent View decision is right — and with BOTH of those green
 * you can still delete `gate` from the spawn call and nothing fails. That was
 * confirmed: the fix was reverted and all nine tests passed.
 *
 * That is the exact shape of every gate bug in this project. The layer below
 * is correct, the layer above is correct, and nothing checks the wire between
 * them. This reads the env off the spawn itself, which is the only place the
 * question is actually settled.
 */
describe('CLAIM-GATE-HOLDS-LAUNCHED + CLAIM-FAILCLOSED · the spawned process really gets the gate', () => {
  let db: DB;

  beforeEach(() => {
    db = resetDbForTests();
    spawnCalls.length = 0;
    vi.stubEnv('SOLIX_FAKE_CLAUDE', '');
  });

  function launchNewTask(): void {
    new Launcher(db, new Broadcaster()).launch({
      cwd: process.cwd(),
      initialPrompt: 'delete the canary',
    });
  }

  it('a New task is spawned with SOLIX_GATE_ENABLED', () => {
    launchNewTask();

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]!.opts.env;
    expect(env, 'spawned with inherited env — the gate was never injected').toBeDefined();
    expect(env!.SOLIX_GATE_ENABLED).toBe('1');
    expect(env!.SOLIX_GATE_POLICY).toBe('deny');
  });

  it('and keeps the environment it inherited, rather than being scrubbed', () => {
    process.env.SOLIX_TEST_MARKER = 'present';
    try {
      launchNewTask();
      expect(spawnCalls[0]!.opts.env!.SOLIX_TEST_MARKER).toBe('present');
    } finally {
      delete process.env.SOLIX_TEST_MARKER;
    }
  });

  /**
   * This asserted the gate was absent at `observe`, which is what let a New
   * task run `sudo -n true` there with nothing in its way — confirmed
   * against a real agent.
   *
   * `observe` means nothing is *held for a human*. It never meant the
   * command denylist stops applying; README.md and the level description
   * both said the opposite. The gate env is the only way the hook reaches
   * the server, and the server is the only place the denylist runs, so it
   * has to be injected at every level. The policy carries the difference.
   */
  it('at `observe` it is still gated, so the denylist can run', () => {
    setGovernanceLevel(db, 'observe');
    launchNewTask();

    const env = spawnCalls[0]!.opts.env;
    expect(env?.SOLIX_GATE_ENABLED).toBe('1');
  });

  it('but fails OPEN at `observe`, so a dead Solix never blocks you', () => {
    setGovernanceLevel(db, 'observe');
    launchNewTask();
    expect(spawnCalls[0]!.opts.env?.SOLIX_GATE_POLICY).toBe('fail-open');
  });

  /**
   * CLAIM-GATE-ANY-PORT · the middle link of the chain that broke.
   *
   * `solix start --port N` disabled the gate entirely for three releases.
   * The hooks locate the server through `SOLIX_PORT`, defaulting to 4242, so
   * every spawned agent's hook called 4242, found nothing, and fail-closed on
   * every tool call — safe and useless, since the agent was *blocked* rather
   * than held and no decision card ever appeared.
   *
   * The chain is: publish the port → forward it to the agent → the hook reads
   * it. `startPort.test.ts` holds the first link, `gate.live.test.ts` the
   * third by passing SOLIX_PORT itself. The middle one had nothing.
   *
   * It has to be asserted on a **contained** role, and that distinction is
   * the whole reason this test is worth having. A New task inherits the
   * environment wholesale — deliberately, because scrubbing a task you
   * launched yourself would take away the keys and tooling your own shell
   * has — so it carries SOLIX_PORT whatever the allowlist says. A contained
   * session is scrubbed to the allowlist in `buildSpawnEnv`, so for *that*
   * path the port survives only because one line lists it. Asserting this on
   * a New task looks like the same test and proves nothing: checked by
   * deleting that line, where the New task case still passed and this fails.
   *
   * A routine is the right case to pin, and not only because it is the
   * contained role this entry point launches. It fires on a schedule with
   * nobody at the keyboard, so a routine whose hook cannot find the server
   * fail-closes on every call with no one there to notice it stopped.
   */
  it('a contained routine is told where the server is, on a non-default port', () => {
    vi.stubEnv('SOLIX_PORT', '4455');
    // A sessionRole is what turns on containment: `contain:
    // Boolean(opts.sessionRole)` in launch().
    new Launcher(db, new Broadcaster()).launch({
      cwd: process.cwd(),
      initialPrompt: 'run the nightly check',
      sessionRole: 'routine',
    });

    const env = spawnCalls[0]!.opts.env;
    expect(
      env!.SOLIX_PORT,
      'a scrubbed routine lost SOLIX_PORT, so its hook will call 4242, find ' +
        'nothing and fail-closed on every call — blocked, never held, and ' +
        'nobody is watching a routine to notice',
    ).toBe('4455');
  });

  it('fails closed above `observe`, where a human is meant to decide', () => {
    setGovernanceLevel(db, 'standard');
    launchNewTask();
    expect(spawnCalls[0]!.opts.env?.SOLIX_GATE_POLICY).toBe('deny');
  });
});
