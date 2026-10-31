import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Uninstall writes to a config file Solix does not own, on someone else's
 * machine. It used to restore the install-time backup wholesale whenever one
 * existed, which silently reverted everything the user had changed in
 * settings.json since they installed — their own hooks, MCP servers,
 * permissions, env.
 *
 * Removing a tool is not consent to roll back a file the tool is a guest in.
 */
let home: string;

async function load() {
  vi.resetModules();
  return import('./uninstall.js');
}

async function loadInstall() {
  vi.resetModules();
  return import('./install.js');
}

function settingsPath() {
  return join(home, '.claude', 'settings.json');
}

function readSettings() {
  return JSON.parse(readFileSync(settingsPath(), 'utf8'));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solix-uninstall-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('SOLIX_HOME', join(home, '.solix'));
  mkdirSync(join(home, '.claude'), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('CLAIM-UNINSTALL-RESTORES · uninstall', () => {
  /**
   * The data-loss regression. Install, then make a change of your own, then
   * uninstall: your change must survive. Against the old wholesale-restore
   * this fails — `addedLater` comes back undefined.
   */
  it('keeps edits made after install', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ mine: 'original' }));
    const { install } = await loadInstall();
    install();

    // The user edits their own settings afterwards, as people do.
    const afterInstall = readSettings();
    afterInstall.addedLater = { mcpServers: ['my-server'] };
    afterInstall.mine = 'edited since';
    writeFileSync(settingsPath(), JSON.stringify(afterInstall, null, 2));

    const { uninstall } = await load();
    uninstall();

    const final = readSettings();
    expect(final.addedLater).toEqual({ mcpServers: ['my-server'] });
    expect(final.mine).toBe('edited since');
  });

  it('removes the Solix hook entries', async () => {
    writeFileSync(settingsPath(), JSON.stringify({}));
    const { install } = await loadInstall();
    install();
    expect(JSON.stringify(readSettings().hooks)).toContain('.solix');

    const { uninstall } = await load();
    uninstall();
    expect(JSON.stringify(readSettings().hooks ?? {})).not.toContain('.solix');
  });

  /** Someone else's hook on the same event must not be collateral damage. */
  it("leaves another tool's hooks alone", async () => {
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        hooks: {
          SessionStart: [
            {
              matcher: '*',
              hooks: [{ type: 'command', command: '/opt/other-tool/hook.sh' }],
            },
          ],
        },
      }),
    );
    const { install } = await loadInstall();
    install();

    const { uninstall } = await load();
    uninstall();

    const hooks = JSON.stringify(readSettings().hooks ?? {});
    expect(hooks).toContain('/opt/other-tool/hook.sh');
    expect(hooks).not.toContain('.solix');
  });

  // The one case surgery cannot handle, and the only one the backup is for.
  it('falls back to the backup only when settings.json will not parse', async () => {
    writeFileSync(settingsPath(), JSON.stringify({ mine: 'original' }));
    const { install } = await loadInstall();
    install();
    writeFileSync(settingsPath(), '{ this is not json');

    const { uninstall } = await load();
    uninstall();
    expect(readSettings().mine).toBe('original');
  });

  it('leaves an unparseable file alone when there is no backup', async () => {
    writeFileSync(settingsPath(), '{ broken');
    const { uninstall } = await load();
    uninstall();
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ broken');
  });

  it('says so when there is nothing to remove', async () => {
    rmSync(join(home, '.claude'), { recursive: true, force: true });
    const { uninstall } = await load();
    expect(() => uninstall()).not.toThrow();
  });
});
