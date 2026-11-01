import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * CLAIM-RESET-KEEPS-A-COPY.
 *
 * 1.18.3 zeroes every recorded cost and token figure, once, because a
 * restart used to re-count part of each transcript and nothing in the
 * database distinguishes real spend from spend counted twice. That is a
 * defensible trade. Doing it without a copy was not.
 *
 * The notice was printed *after* the `UPDATE`s had run. The function's own
 * docstring says "a product whose front page is 'watch the money' should not
 * zero your spend history in silence" — and it was not silent, but reporting
 * a fait accompli is not disclosure. There was no backup and no way to
 * decline.
 *
 * Twenty files away, `start` says "on first run, say what is about to be
 * written before writing it": it discloses the nine hooks and fifteen agent
 * files beforehand, backs `settings.json` up first, and offers `--no-wire`.
 * All for a config write that `solix uninstall` reverses. So the product
 * announced a reversible change in advance and destroyed unrecoverable data
 * with a notice afterwards — the right instinct, applied to the wrong one of
 * the two.
 *
 * `DB_PATH` is a module constant read from the environment at import time,
 * so each test gets a fresh temp home and a fresh module graph.
 */
let home: string;
let logs: string[];

async function load() {
  vi.resetModules();
  const [create, db, sessions, missions, projects] = await Promise.all([
    import('./create.js'),
    import('./db.js'),
    import('./state/sessions.js'),
    import('./state/missions.js'),
    import('./state/projects.js'),
  ]);
  return { ...create, ...db, ...sessions, ...missions, ...projects };
}

/** A database on disk with real spend in it. */
async function seeded() {
  const mod = await load();
  const db = mod.resetDbForTests(join(home, 'solix.db'));
  const project = mod.ensureProject(db, '/tmp/work');
  mod.upsertSession(db, {
    id: 's1',
    pid: 1,
    projectId: project.id,
    cwd: '/tmp/work',
    origin: 'external',
  });
  mod.setSessionCost(db, 's1', 12.34);
  return { mod, db };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solix-reset-'));
  vi.stubEnv('SOLIX_HOME', home);
  vi.stubEnv('SOLIX_DB_PATH', join(home, 'solix.db'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void logs.push(a.join(' ')));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const backups = () => readdirSync(home).filter((f) => f.endsWith('.bak'));
const text = () => logs.join('\n');

describe('CLAIM-RESET-KEEPS-A-COPY · resetDoubleCountedSpend', () => {
  it('still does the thing it exists to do', () => {
    // The reset itself is not in question — the figures were wrong and there
    // is no migration that could correct them.
    return seeded().then(({ mod, db }) => {
      expect(mod.getSession(db, 's1')!.costUsd).toBe(12.34);
      mod.resetDoubleCountedSpend(db);
      expect(mod.getSession(db, 's1')!.costUsd).toBe(0);
    });
  });

  it('leaves a copy of the figures beside the database', async () => {
    const { mod, db } = await seeded();

    mod.resetDoubleCountedSpend(db);

    const made = backups();
    expect(made, 'nothing was copied before the figures were destroyed').toHaveLength(1);
    expect(made[0]).toMatch(/\.bak$/);
  });

  it('and the copy still has the old figures in it', async () => {
    // A file of the right name proves nothing. This opens it.
    const { mod, db } = await seeded();
    mod.resetDoubleCountedSpend(db);
    const backupPath = join(home, backups()[0]!);

    const restored = mod.resetDbForTests(backupPath);
    const row = restored
      .prepare('SELECT cost_usd FROM sessions WHERE id = ?')
      .get('s1') as { cost_usd: number };

    expect(row.cost_usd, 'the backup was taken after the wipe, not before').toBe(12.34);
  });

  it('says where the copy is, before it destroys anything', async () => {
    const { mod, db } = await seeded();
    mod.resetDoubleCountedSpend(db);

    expect(text()).toMatch(/about to reset/);
    expect(text()).toContain(join(home, backups()[0]!));
    // "about to" rather than "reset spend on N sessions" in the past tense:
    // the whole point is that this is said while there is still time to stop
    // the server and copy the file somewhere else.
    expect(text()).not.toMatch(/^\[solix\] reset spend on/m);
  });

  it('happens once, and does not copy again on the next start', async () => {
    const { mod, db } = await seeded();
    mod.resetDoubleCountedSpend(db);
    const first = backups();
    logs = [];

    mod.resetDoubleCountedSpend(db);

    expect(backups(), 'a second start must not overwrite the only copy').toEqual(first);
    expect(logs, 'and must say nothing').toEqual([]);
  });

  it('says nothing and copies nothing on a fresh install', async () => {
    // No recorded figures means nothing to lose. A brand-new user should not
    // meet a paragraph about a reset that did not apply to them.
    const mod = await load();
    const db = mod.resetDbForTests(join(home, 'solix.db'));

    mod.resetDoubleCountedSpend(db);

    expect(backups()).toEqual([]);
    expect(logs).toEqual([]);
  });

  it('still resets, and says so, when the copy cannot be made', async () => {
    // A failed backup must not stop a server starting — but it must change
    // what we claim, or the message promises a file that is not there.
    const mod = await load();
    const db = mod.resetDbForTests(':memory:'); // DB_PATH has no file behind it
    const project = mod.ensureProject(db, '/tmp/work');
    mod.upsertSession(db, {
      id: 's1',
      pid: 1,
      projectId: project.id,
      cwd: '/tmp/work',
      origin: 'external',
    });
    mod.setSessionCost(db, 's1', 5);

    mod.resetDoubleCountedSpend(db);

    expect(mod.getSession(db, 's1')!.costUsd).toBe(0);
    expect(text()).toMatch(/not recoverable/);
    expect(text()).not.toMatch(/kept at/);
  });
});
