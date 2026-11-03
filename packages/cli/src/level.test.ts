import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CLAIM-DOWNGRADE-NEEDS-FORCE at the CLI. `solix level observe` while a plan's
 * workers are running would ungate them mid-task; it must refuse without
 * --force. `solix level` writes the DB directly (no server), so it reads the
 * in-flight count straight from it.
 */
let home: string;
const logs: string[] = [];
const errs: string[] = [];

async function load() {
  vi.resetModules();
  const level = await import('./level.js');
  const db = await import('@solix/server/db');
  const sessions = await import('@solix/server/sessions');
  const governance = await import('@solix/server/governance');
  const projects = await import('@solix/server/projects');
  return { ...level, ...db, ...sessions, ...governance, ...projects };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solix-level-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('SOLIX_HOME', join(home, '.solix'));
  logs.length = 0;
  errs.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void errs.push(a.join(' ')));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = undefined;
});

function startWorker(m: Awaited<ReturnType<typeof load>>) {
  const project = m.ensureProject(m.getDb(), '/tmp/lvl');
  m.upsertSession(m.getDb(), {
    id: 'w1',
    pid: 1,
    projectId: project.id,
    cwd: '/tmp/lvl',
    origin: 'internal',
    sessionRole: 'worker',
  });
}

describe('solix level', () => {
  it('refuses to drop to observe while a worker is running, without --force', async () => {
    const m = await load();
    m.setGovernanceLevel(m.getDb(), 'standard');
    startWorker(m);
    m.level('observe');
    expect(process.exitCode).toBe(1);
    expect(errs.join('\n')).toMatch(/contained session/i);
    expect(m.getGovernanceLevel(m.getDb())).toBe('standard'); // unchanged
  });

  it('drops with --force', async () => {
    const m = await load();
    m.setGovernanceLevel(m.getDb(), 'standard');
    startWorker(m);
    m.level('observe', { force: true });
    expect(process.exitCode).toBeUndefined();
    expect(m.getGovernanceLevel(m.getDb())).toBe('observe');
  });

  it('drops freely when nothing contained is running', async () => {
    const m = await load();
    m.setGovernanceLevel(m.getDb(), 'standard');
    m.level('observe');
    expect(m.getGovernanceLevel(m.getDb())).toBe('observe');
  });

  it('never blocks raising the level', async () => {
    const m = await load();
    m.setGovernanceLevel(m.getDb(), 'standard');
    startWorker(m);
    m.level('strict');
    expect(m.getGovernanceLevel(m.getDb())).toBe('strict');
  });
});
