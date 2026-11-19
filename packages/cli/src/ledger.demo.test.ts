import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDbForTests } from '@solix/server/db';
import { ledger } from './ledger.js';

/**
 * `solix ledger --demo`. Reported by an outside tester on 2026-11-19: after
 * approving and denying held commands in `solix demo`, `solix ledger` said
 * "No decisions yet". The demo writes to its own sandbox database, which the
 * ledger never read, and nothing said so.
 */
let home: string;
let out: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solix-ledger-demo-'));
  vi.stubEnv('SOLIX_HOME', home);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetDbForTests();
  rmSync(home, { recursive: true, force: true });
});

const plain = () => out.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

/** A demo sandbox holding one approved and one denied call. */
function demoSandbox(): void {
  const db = resetDbForTests(join(home, 'demo.db'));
  const insert = db.prepare(
    'INSERT INTO audit_events (id, ts, kind, summary, payload_json) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run('a1', Date.now() - 1000, 'permission_approved', 'approved', JSON.stringify({ tool: 'Bash', args: { command: 'git push origin main' } }));
  insert.run('a2', Date.now() - 500, 'permission_denied', 'denied', JSON.stringify({ tool: 'Bash', args: { command: 'rm -rf canary/' } }));
  // Back to an empty real record, as on a machine that has only run the demo.
  resetDbForTests();
}

describe('CLAIM-DEMO-DECISIONS-IN-LEDGER: solix ledger --demo', () => {
  it('reads the demo sandbox and says the data is invented', () => {
    demoSandbox();
    ledger({ demo: true });
    expect(plain()).toContain('solix demo sandbox, invented data');
    expect(plain()).toContain('git push origin main');
    expect(plain()).toContain('rm -rf canary/');
    expect(plain()).toContain('2 decisions in the window');
  });

  it('plain `solix ledger` points at the sandbox instead of only saying "No decisions yet"', () => {
    demoSandbox();
    ledger({});
    expect(plain()).toContain('No decisions yet');
    expect(plain()).toContain('solix ledger --demo');
  });

  it('says plainly when there is no sandbox to read', () => {
    ledger({ demo: true });
    expect(plain()).toMatch(/No demo sandbox at .*demo\.db/);
    ledger({});
    expect(plain()).not.toContain('solix ledger --demo');
  });
});
