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
describe('the spawned process really gets the gate', () => {
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

  it('at `observe` it is spawned ungated, because that is what observe means', () => {
    setGovernanceLevel(db, 'observe');
    launchNewTask();

    const env = spawnCalls[0]!.opts.env;
    // undefined = inherit unchanged; or present but without the gate flag.
    expect(env?.SOLIX_GATE_ENABLED).toBeUndefined();
  });
});
