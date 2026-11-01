import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAndPublishPort } from './start.js';

/**
 * `solix start --port N` silently broke the gate.
 *
 * The hooks are shell scripts that find the server through `SOLIX_PORT`,
 * defaulting to 4242, and `buildSpawnEnv` forwards that variable from the
 * server process to the agents it spawns. The `--port` flag moved the
 * server and set nothing, so every spawned agent's hook called 4242, found
 * nothing, and fail-closed.
 *
 * The outcome was safe and useless: the agent was *blocked* on every tool
 * call rather than held for a human. No decision card ever appeared, and
 * the only trace was "Solix gate unavailable (fail-closed)" inside a
 * worker's report. Found by running Suite E on a non-default port — and the
 * EADDRINUSE message shipped days earlier actively recommends `--port`.
 */
const SAVED = process.env.SOLIX_PORT;

beforeEach(() => {
  delete process.env.SOLIX_PORT;
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.SOLIX_PORT;
  else process.env.SOLIX_PORT = SAVED;
});

describe('CLAIM-GATE-ANY-PORT · resolveAndPublishPort', () => {
  /** The regression: the flag has to reach the hooks, not just the listener. */
  it('publishes an explicit --port so the hooks can find the server', () => {
    expect(resolveAndPublishPort({ port: 4360 })).toBe(4360);
    expect(process.env.SOLIX_PORT).toBe('4360');
  });

  it('publishes the default when no port was given', () => {
    expect(resolveAndPublishPort({})).toBe(4242);
    expect(process.env.SOLIX_PORT).toBe('4242');
  });

  it('honours SOLIX_PORT when there is no flag', () => {
    process.env.SOLIX_PORT = '4555';
    expect(resolveAndPublishPort({})).toBe(4555);
    expect(process.env.SOLIX_PORT).toBe('4555');
  });

  /**
   * The same claim, reached by a different road.
   *
   * `opts.port ?? Number(process.env.SOLIX_PORT ?? 4242)` reads `SOLIX_PORT=`
   * — set but empty — as port **0**, because `??` only fires on null and
   * undefined. `solix start` then binds a random free port and publishes "0",
   * so every spawned agent's hook calls port 0, finds nothing, and fail-closes
   * on every tool call: the original defect exactly, from an empty variable
   * instead of a flag. A conditional CI step or a half-filled .env is enough.
   */
  it('ignores a SOLIX_PORT that is set but empty, rather than binding port 0', () => {
    process.env.SOLIX_PORT = '';
    expect(resolveAndPublishPort({})).toBe(4242);
    expect(process.env.SOLIX_PORT).toBe('4242');
  });

  it('ignores a SOLIX_PORT that is not a port', () => {
    for (const raw of ['auto', '0', '-1', '99999']) {
      process.env.SOLIX_PORT = raw;
      expect(resolveAndPublishPort({}), raw).toBe(4242);
    }
  });

  /** The flag is the more specific instruction, so it wins — and republishes. */
  it('lets the flag beat the variable, and republishes the winner', () => {
    process.env.SOLIX_PORT = '4555';
    expect(resolveAndPublishPort({ port: 4360 })).toBe(4360);
    expect(process.env.SOLIX_PORT).toBe('4360');
  });
});
