import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

describe('claudeBinaryPresent', () => {
  /**
   * Found by walking the partner brief's install sequence against a packed
   * tarball, on a machine where `claude --version` printed 2.1.316.
   *
   * `start` decided whether to wire hooks with `claudeCodePresent()`, which
   * is `existsSync(~/.claude)` — "has Claude Code ever *run*". So installing
   * Claude Code and running `solix` before ever running `claude` printed
   * "Claude Code not detected … install Claude Code and restart Solix",
   * wired nothing, and left a new user watching an empty galaxy having been
   * told to install software they had just installed.
   *
   * The directory is what we merge into. The binary is what decides whether
   * merging is worth doing. They are different questions and `start` now
   * asks both.
   */
  it('finds a binary named by SOLIX_CLAUDE_BIN', async () => {
    const fake = join(home, 'claude');
    writeFileSync(fake, '#!/bin/sh\necho 2.1.0\n');
    vi.stubEnv('SOLIX_CLAUDE_BIN', fake);
    const { claudeBinaryPresent } = await load();
    expect(claudeBinaryPresent()).toBe(true);
  });

  it('is false when SOLIX_CLAUDE_BIN points at nothing', async () => {
    // Naming a path that does not exist is a stronger signal than silence:
    // the user told us where it is and they were wrong.
    vi.stubEnv('SOLIX_CLAUDE_BIN', join(home, 'nope', 'claude'));
    const { claudeBinaryPresent } = await load();
    expect(claudeBinaryPresent()).toBe(false);
  });

  it('falls back to looking on PATH', async () => {
    const bin = join(home, 'bin');
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, 'claude');
    writeFileSync(fake, '#!/bin/sh\necho 2.1.0\n');
    chmodSync(fake, 0o755);
    vi.stubEnv('SOLIX_CLAUDE_BIN', '');
    vi.stubEnv('PATH', bin);
    const { claudeBinaryPresent } = await load();
    expect(claudeBinaryPresent()).toBe(true);
  });

  it('is false when it is on neither', async () => {
    vi.stubEnv('SOLIX_CLAUDE_BIN', '');
    vi.stubEnv('PATH', join(home, 'empty'));
    const { claudeBinaryPresent } = await load();
    expect(claudeBinaryPresent()).toBe(false);
  });

  it('answers a different question from claudeCodePresent', () => {
    // The whole bug in one sentence: a machine can have the binary and no
    // config directory, and that combination must still wire.
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});

describe('hooksSupported', () => {
  /**
   * The hooks are POSIX `sh` using $PPID, `date +%s`, `pwd` and `curl`.
   * Native Windows cmd cannot execute them, so writing and registering them
   * there produces hooks that never fire and a user with no idea why —
   * which is worse than declining.
   */
  it('is false on native Windows', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { hooksSupported } = await load();
    expect(hooksSupported()).toBe(false);
    vi.unstubAllGlobals();
  });

  // WSL reports as linux, which is why "run it under WSL" is a real answer
  // for Windows users rather than a brush-off.
  it('is true on linux and darwin', async () => {
    for (const platform of ['linux', 'darwin']) {
      vi.stubGlobal('process', { ...process, platform });
      vi.resetModules();
      const { hooksSupported } = await import('./install.js');
      expect(hooksSupported()).toBe(true);
      vi.unstubAllGlobals();
    }
  });
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

/**
 * The install path used to read an unparseable settings.json as `{}` and then
 * write that back out, so one trailing comma in the user's file replaced
 * their permissions, env, model and MCP config with Solix's hooks alone —
 * and printed "merged hooks into ..." as though it had merged. The backup
 * covered only the first such write, since it is taken once and never
 * refreshed.
 *
 * `uninstall.ts` had already argued the general case and got it right:
 * uninstalling a tool is not consent to roll back a config file the tool
 * does not own. Neither is installing one.
 *
 * The property under test is the strong one — not "it warns" but "the file
 * on disk is byte-for-byte what it was".
 */
describe('CLAIM-INSTALL-NEVER-CLOBBERS · install() and an unreadable settings.json', () => {
  const REAL_CONFIG = `{
  // a comment, which JSON does not allow and Claude Code tolerates
  "permissions": { "allow": ["Bash(npm test)"] },
  "env": { "ANTHROPIC_API_KEY": "sk-dont-lose-me" },
  "model": "opus",
  "statusLine": { "type": "command", "command": "~/bin/line.sh" },
}`;

  async function withSettings(body: string) {
    const claude = join(home, '.claude');
    mkdirSync(claude, { recursive: true });
    const settings = join(claude, 'settings.json');
    writeFileSync(settings, body);
    return { claude, settings, mod: await load() };
  }

  it('throws instead of writing, and leaves the file untouched', async () => {
    const { settings, mod } = await withSettings(REAL_CONFIG);
    const { readFileSync } = await import('node:fs');

    expect(() => mod.install()).toThrow(mod.SettingsUnreadableError);
    expect(readFileSync(settings, 'utf8')).toBe(REAL_CONFIG);
  });

  it('says what it did not do, and how to fix it', async () => {
    const { mod } = await withSettings(REAL_CONFIG);
    let message = '';
    try {
      mod.install();
    } catch (err) {
      message = (err as Error).message;
    }
    // The three things someone needs: nothing changed, why, what to do.
    expect(message).toContain('nothing was changed');
    expect(message).toMatch(/permissions/);
    expect(message).toMatch(/run Solix again/);
  });

  it('does not claim to have merged', async () => {
    const { mod } = await withSettings(REAL_CONFIG);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      mod.install();
    } catch {
      /* expected */
    }
    const said = log.mock.calls.flat().join('\n');
    expect(said).not.toContain('merged hooks into');
    log.mockRestore();
  });

  it('refuses a file that parses but is not an object', async () => {
    const { settings, mod } = await withSettings('["not", "settings"]');
    const { readFileSync } = await import('node:fs');
    expect(() => mod.install()).toThrow(mod.SettingsUnreadableError);
    expect(readFileSync(settings, 'utf8')).toBe('["not", "settings"]');
  });

  it('does not write the install stamp, so the next start retries', async () => {
    const { mod } = await withSettings(REAL_CONFIG);
    const { existsSync } = await import('node:fs');
    try {
      mod.install();
    } catch {
      /* expected */
    }
    expect(existsSync(join(home, '.solix', 'installed-version'))).toBe(false);
    expect(mod.hooksUpToDate()).toBe(false);
  });

  /** An empty file is not malformed — Claude Code reads it as no settings. */
  it('treats an empty file as no settings and installs normally', async () => {
    const { settings, mod } = await withSettings('   \n');
    const { readFileSync } = await import('node:fs');
    expect(() => mod.install()).not.toThrow();
    expect(JSON.stringify(JSON.parse(readFileSync(settings, 'utf8')).hooks)).toContain(
      'hooks',
    );
  });
});

/**
 * CLAUDE_BACKUP is the pre-Solix original and `uninstall` restores from it,
 * so it must never be refreshed — otherwise "restore my settings" restores a
 * file Solix wrote. That left upgrades, which re-run the install and
 * re-write settings.json, with no backup at all.
 */
describe('install() backups across an upgrade', () => {
  it('keeps the original backup and adds a pre-write one', async () => {
    const claude = join(home, '.claude');
    mkdirSync(claude, { recursive: true });
    const settings = join(claude, 'settings.json');
    writeFileSync(settings, JSON.stringify({ era: 'before solix' }));

    const { install } = await load();
    install();

    // Simulate the user editing their settings, then an upgrade re-running.
    const between = JSON.parse(
      (await import('node:fs')).readFileSync(settings, 'utf8'),
    );
    between.era = 'after my own edit';
    writeFileSync(settings, JSON.stringify(between));
    install({ force: true });

    const { readFileSync } = await import('node:fs');
    expect(
      JSON.parse(readFileSync(join(claude, 'settings.solix.backup.json'), 'utf8')).era,
    ).toBe('before solix');
    expect(
      JSON.parse(readFileSync(join(claude, 'settings.solix.prev.json'), 'utf8')).era,
    ).toBe('after my own edit');
  });
});

/**
 * `~/.claude/agents` is Claude Code's directory, and a user may have written
 * their own agents into it. install() copied fifteen advisor files in with an
 * unconditional copyFileSync — no existence check, no backup, no mention
 * beyond "installed 15 advisor agents" — so an agent you wrote called
 * `forge.md` was gone. And uninstall never removed any of them, which made
 * start's "undo any time with `solix uninstall`" untrue.
 */
describe('advisor agents in the user\'s own directory', () => {
  const MINE = '# my own forge agent\nDo not lose me.\n';

  function writeMyAgent(): string {
    const dir = join(home, '.claude', 'agents');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'forge.md');
    writeFileSync(path, MINE);
    return path;
  }

  it('preserves a colliding agent file instead of just overwriting it', async () => {
    const mine = writeMyAgent();
    const { install } = await load();
    install();

    const { readFileSync, existsSync } = await import('node:fs');
    expect(existsSync(`${mine}.pre-solix.bak`)).toBe(true);
    expect(readFileSync(`${mine}.pre-solix.bak`, 'utf8')).toBe(MINE);
    // Solix's own version is in place, so the product still works.
    expect(readFileSync(mine, 'utf8')).not.toBe(MINE);
  });

  it('does not overwrite that backup on a second install', async () => {
    const mine = writeMyAgent();
    const { install } = await load();
    install();
    install({ force: true });

    const { readFileSync } = await import('node:fs');
    expect(readFileSync(`${mine}.pre-solix.bak`, 'utf8')).toBe(MINE);
  });

  it('records what it installed', async () => {
    const { install, readAgentsManifest } = await load();
    install();
    const names = readAgentsManifest();
    expect(names).toContain('forge.md');
    expect(names.length).toBe(15);
  });

  it('uninstall removes the agents it installed', async () => {
    const { install } = await load();
    install();
    const { existsSync } = await import('node:fs');
    const forge = join(home, '.claude', 'agents', 'forge.md');
    expect(existsSync(forge)).toBe(true);

    const { uninstall } = await import('./uninstall.js');
    uninstall();
    expect(existsSync(forge)).toBe(false);
  });

  it('uninstall puts back an agent of yours that it displaced', async () => {
    const mine = writeMyAgent();
    const { install } = await load();
    install();
    const { uninstall } = await import('./uninstall.js');
    uninstall();

    const { readFileSync, existsSync } = await import('node:fs');
    expect(readFileSync(mine, 'utf8')).toBe(MINE);
    expect(existsSync(`${mine}.pre-solix.bak`)).toBe(false);
  });

  /** The reason the manifest exists rather than deleting by pattern. */
  it('uninstall leaves an agent Solix never installed', async () => {
    const { install } = await load();
    install();

    const dir = join(home, '.claude', 'agents');
    const stranger = join(dir, 'my-own-thing.md');
    writeFileSync(stranger, 'mine\n');

    const { uninstall } = await import('./uninstall.js');
    uninstall();

    const { existsSync } = await import('node:fs');
    expect(existsSync(stranger)).toBe(true);
  });

  /** Uninstalling a wrapper is not consent to delete your cost history. */
  it('uninstall keeps the database', async () => {
    const { install } = await load();
    install();
    const db = join(home, '.solix', 'solix.db');
    writeFileSync(db, 'pretend sqlite\n');

    const { uninstall } = await import('./uninstall.js');
    uninstall();

    const { existsSync } = await import('node:fs');
    expect(existsSync(db)).toBe(true);
  });
});
