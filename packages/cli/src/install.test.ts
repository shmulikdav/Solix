import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `solix start` wires the Claude Code hooks itself on first run, so these two
 * predicates decide whether a new user gets a working install or an empty
 * galaxy. Before this, `start` never checked: it booted the server, opened
 * the browser and printed "start any `claude` session to see your first
 * planet appear" whether or not anything was wired — so someone who skipped
 * `solix install` watched nothing happen, forever, with no error.
 *
 * The constants in paths.ts are computed at module load from $HOME and
 * $SOLIX_HOME, so each test gets a fresh temp home and a fresh module graph.
 */
let home: string;

async function load() {
  vi.resetModules();
  return import('./install.js');
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solix-install-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('SOLIX_HOME', join(home, '.solix'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('claudeCodePresent', () => {
  it('is false when Claude Code has never run', async () => {
    const { claudeCodePresent } = await load();
    expect(claudeCodePresent()).toBe(false);
  });

  it('is true once ~/.claude exists', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const { claudeCodePresent } = await load();
    expect(claudeCodePresent()).toBe(true);
  });
});

describe('hooksInstalled', () => {
  it('is false on a clean machine', async () => {
    const { hooksInstalled } = await load();
    expect(hooksInstalled()).toBe(false);
  });

  // The failure this is really guarding: settings.json exists and looks
  // plausible, but nothing points at Solix. Checking only for the file would
  // report success and the user would see an empty galaxy.
  it('is false when settings.json exists but has no Solix hooks', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [] } }),
    );
    const { hooksInstalled } = await load();
    expect(hooksInstalled()).toBe(false);
  });

  /**
   * The invariant that makes auto-wiring safe. If install() does not satisfy
   * hooksInstalled(), `solix start` either re-installs on every single launch
   * or never installs at all — and both failures are silent.
   */
  it('is true after install(), so start wires exactly once', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const { hooksInstalled, install } = await load();
    expect(hooksInstalled()).toBe(false);
    install();
    expect(hooksInstalled()).toBe(true);
  });

  it('install() is idempotent — a second run still reports installed', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const { hooksInstalled, install } = await load();
    install();
    install();
    expect(hooksInstalled()).toBe(true);
  });

  /**
   * The upgrade bug. An existence check cannot tell "current" from "written
   * by a release two versions ago", so `solix start` would skip the rewire
   * and the user would keep running stale hook scripts indefinitely — every
   * shipped fix landing on a machine that never picks it up.
   */
  it('reports out-of-date when the hooks were written by another version', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const { hooksInstalled, hooksUpToDate, install } = await load();
    install();
    expect(hooksUpToDate()).toBe(true);

    // Simulate an upgrade: same files on disk, older stamp.
    writeFileSync(join(home, '.solix', 'installed-version'), '0.0.1\n');
    expect(hooksInstalled()).toBe(true); // files are still there…
    expect(hooksUpToDate()).toBe(false); // …but they are not ours
  });

  it('treats an unstamped install as out of date', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const { hooksInstalled, hooksUpToDate, install, installedVersion } =
      await load();
    install();
    rmSync(join(home, '.solix', 'installed-version'));
    expect(installedVersion()).toBeNull();
    expect(hooksInstalled()).toBe(true);
    expect(hooksUpToDate()).toBe(false);
  });

  // install() backs settings.json up before touching it, which is what makes
  // doing this without asking defensible — `solix uninstall` restores it.
  it('backs up an existing settings.json before merging', async () => {
    const claude = join(home, '.claude');
    mkdirSync(claude, { recursive: true });
    writeFileSync(
      join(claude, 'settings.json'),
      JSON.stringify({ mine: 'keep me' }),
    );
    const { install } = await load();
    install();

    const { readFileSync, existsSync } = await import('node:fs');
    const backup = join(claude, 'settings.solix.backup.json');
    expect(existsSync(backup)).toBe(true);
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual({
      mine: 'keep me',
    });
    // ...and the user's own keys survive the merge.
    const merged = JSON.parse(
      readFileSync(join(claude, 'settings.json'), 'utf8'),
    );
    expect(merged.mine).toBe('keep me');
    expect(JSON.stringify(merged.hooks)).toContain('hooks');
  });
});
