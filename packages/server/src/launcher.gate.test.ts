import { describe, expect, it } from 'vitest';

import { buildSpawnEnvForTest } from './launcher.js';

/**
 * Is the gate actually switched on for the session being launched?
 *
 * Every other gate test starts *after* the gate is reached. None of them
 * could catch the gate never being switched on — which is exactly what
 * happened: a New task carried no `SOLIX_GATE_ENABLED` at any level, its
 * hook never blocked, and no decision was ever raised. The Decisions panel
 * looked broken for a day because it was correctly showing nothing.
 *
 * These assert the env a child is actually handed.
 */
describe('spawn env: who gets the gate', () => {
  describe('an autonomous worker (contain)', () => {
    it('gets the gate, fail-closed', () => {
      const env = buildSpawnEnvForTest(true, false)!;
      expect(env.SOLIX_GATE_ENABLED).toBe('1');
      expect(env.SOLIX_GATE_POLICY).toBe('deny');
    });

    it('is scrubbed to an allowlist — least privilege, nobody watching', () => {
      const env = buildSpawnEnvForTest(true, false)!;
      expect(env.PATH).toBeDefined();
      expect(env.HOME).toBeDefined();
      // Something arbitrary from the ambient env must NOT survive.
      expect(env.SOLIX_TEST_ARBITRARY_VALUE).toBeUndefined();
    });
  });

  describe('a task you launched (gate, not contain)', () => {
    it('gets the gate', () => {
      const env = buildSpawnEnvForTest(false, true)!;
      expect(env.SOLIX_GATE_ENABLED).toBe('1');
      expect(env.SOLIX_GATE_POLICY).toBe('deny');
    });

    /**
     * The distinction that matters. Scrubbing a worker is least privilege;
     * scrubbing YOUR task would take away the keys and tooling your own
     * shell has, to protect you from yourself. Your env, held commands.
     */
    it('keeps your environment', () => {
      process.env.SOLIX_TEST_ARBITRARY_VALUE = 'kept';
      try {
        const env = buildSpawnEnvForTest(false, true)!;
        expect(env.SOLIX_TEST_ARBITRARY_VALUE).toBe('kept');
      } finally {
        delete process.env.SOLIX_TEST_ARBITRARY_VALUE;
      }
    });
  });

  describe('neither', () => {
    it('inherits everything, unchanged', () => {
      expect(buildSpawnEnvForTest(false, false)).toBeUndefined();
    });
  });

  describe('an explicit containment opt-out', () => {
    it('is honoured — no gate is forced on someone who turned it off', () => {
      process.env.SOLIX_CONTAINMENT = '0';
      try {
        // Nothing to inject, so the child inherits as it always did.
        expect(buildSpawnEnvForTest(false, true)).toBeUndefined();
      } finally {
        delete process.env.SOLIX_CONTAINMENT;
      }
    });
  });
});
