import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `solix doctor` is the thing you run when you do not trust the rest of it —
 * the brief and three error messages all point here — and 288 lines of it had
 * no test.
 *
 * Its own comments record two defects already shipped, and both are the
 * week's shape rather than a crash:
 *
 *   • `ok: skillCount >= 0` on a `.length` — a check that could not fail, so
 *     it reported health it had never established.
 *   • the backup check was red on a perfectly healthy machine, telling people
 *     to run a command that could not produce what it was asking for. "A
 *     health check that is permanently red on a healthy machine teaches people
 *     to ignore health checks, which is worse than not having it."
 *
 * So the first test here is the keystone: a fully installed machine with a
 * server up must pass *everything*. Without it, every ✗ in the tests below
 * proves nothing — a check that is always red is green-looking from inside a
 * test that only ever asserts red.
 */

let home: string;
let lines: string[];

const ANSI = /\x1b\[[0-9;]*m/g;

async function load() {
  vi.resetModules();
  const [doctorMod, paths] = await Promise.all([
    import('./doctor.js'),
    import('./paths.js'),
  ]);
  return { ...doctorMod, ...paths };
}

/** Everything a healthy install puts on disk, at the version under test. */
function fullInstall(hookNames: readonly string[]): void {
  mkdirSync(join(home, '.solix', 'hooks'), { recursive: true });
  for (const n of hookNames) {
    writeFileSync(join(home, '.solix', 'hooks', `${n}.sh`), '#!/bin/sh\n');
  }
  mkdirSync(join(home, '.solix', 'skills', 'solix-gate'), { recursive: true });
  writeFileSync(join(home, '.solix', 'installed-version'), '0.0.0-test');
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
  writeFileSync(join(home, '.claude', 'agents', 'argus.md'), '# Argus\n');
  writeFileSync(join(home, '.claude', 'settings.json'), '{}');
  writeFileSync(join(home, '.claude', 'settings.solix.backup.json'), '{}');
}

interface FakeRes {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** A server that answers all three probes the way a healthy one does. */
function healthyServer(port = 4242): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string): Promise<FakeRes> => {
    urls.push(url);
    if (!url.startsWith(`http://127.0.0.1:${port}/`)) {
      throw new Error('ECONNREFUSED');
    }
    if (url.endsWith('/api/wrappers')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    if (url.endsWith('/api/system/preflight')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          claudeAvailable: true,
          agentViewAvailable: true,
          version: '2.1.140',
        }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  return { urls };
}

/** Nothing listening anywhere. */
function noServer(): { urls: string[] } {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (url: string): Promise<FakeRes> => {
    urls.push(url);
    throw new Error('ECONNREFUSED');
  });
  return { urls };
}

/** The printed report, ANSI stripped, as `{ ok, label, detail }` per line. */
function report(): { ok: boolean; label: string; detail: string }[] {
  return lines
    .map((l) => l.replace(ANSI, ''))
    .filter((l) => l.startsWith('✓') || l.startsWith('✗'))
    .map((l) => {
      const ok = l.startsWith('✓');
      const rest = l.slice(2);
      const [label, ...detail] = rest.split('  ');
      return { ok, label: label!.trim(), detail: detail.join('  ').trim() };
    });
}

function check(label: string): { ok: boolean; label: string; detail: string } {
  const found = report().find((c) => c.label === label);
  if (!found) {
    throw new Error(
      `no check labelled "${label}" — got:\n${report()
        .map((c) => `  ${c.ok ? '✓' : '✗'} ${c.label}`)
        .join('\n')}`,
    );
  }
  return found;
}

const text = (): string => lines.join('\n').replace(ANSI, '');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solix-doctor-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('SOLIX_HOME', join(home, '.solix'));
  vi.stubEnv('SOLIX_PORT', undefined);
  lines = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void lines.push(a.join(' ')));
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  rmSync(home, { recursive: true, force: true });
});

describe('CLAIM-DOCTOR-REPORTS-REAL-STATE · doctor', () => {
  it('passes every check on a healthy machine, and sets no failure exit code', async () => {
    // The keystone. Two checks here have shipped broken in the "red on a
    // healthy machine" direction, and one shipped in the "could never go red"
    // direction; this is the only test that can catch the first kind.
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    healthyServer();

    await doctor();

    const red = report().filter((c) => !c.ok);
    expect(red, `unexpected failures: ${red.map((c) => c.label).join(', ')}`).toEqual(
      [],
    );
    expect(text()).toContain('All checks passed');
    expect(process.exitCode).toBeUndefined();
  });

  it('fails on a machine where nothing is installed, and names what to run', async () => {
    const { doctor } = await load();
    noServer();

    await doctor();

    expect(check('Solix home directory').ok).toBe(false);
    expect(check('Hook scripts installed').ok).toBe(false);
    expect(check('Advisor agents installed').detail).toMatch(/run `solix install`/);
    expect(check('Solix skill pack').detail).toMatch(/run `solix install`/);
    expect(process.exitCode).toBe(1);
  });

  it('does not call a missing backup a problem when there was nothing to back up', async () => {
    // install() only writes a backup when a settings.json already existed.
    // A clean first install therefore has none, and reporting ✗ with "run
    // `solix install`" sent people to a command that could never produce one.
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    unlinkSync(join(home, '.claude', 'settings.solix.backup.json'));
    healthyServer();

    await doctor();

    const c = check('Backup of settings.json');
    expect(c.ok).toBe(true);
    expect(c.detail).toMatch(/nothing to back up|not needed/);
  });

  it('does report a missing backup when Solix has never installed', async () => {
    // The other half: no stamp means install() never ran, so the absent
    // backup is real news and `solix install` is the right advice.
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    unlinkSync(join(home, '.claude', 'settings.solix.backup.json'));
    unlinkSync(join(home, '.solix', 'installed-version'));
    healthyServer();

    await doctor();

    const c = check('Backup of settings.json');
    expect(c.ok).toBe(false);
    expect(c.detail).toMatch(/run `solix install`/);
  });

  it('names the hook scripts that are missing rather than just the count', async () => {
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    unlinkSync(join(home, '.solix', 'hooks', 'pre-tool-bash.sh'));
    healthyServer();

    await doctor();

    const c = check('Hook scripts installed');
    expect(c.ok).toBe(false);
    // pre-tool-bash is the gate's own hook: knowing *which* one is gone is
    // the difference between a diagnosis and a shrug.
    expect(c.detail).toContain('pre-tool-bash');
  });

  it('flags hooks left behind by an older version and says how to fix it', async () => {
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    writeFileSync(join(home, '.solix', 'installed-version'), '1.2.3');
    healthyServer();

    await doctor();

    const c = check('Hooks match this version');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('1.2.3');
    expect(c.detail).toContain('0.0.0-test');
    expect(c.detail).toMatch(/restart solix/);
  });

  it('does not count an empty skills directory as a skill pack', async () => {
    // This check was `ok: skillCount >= 0` on a `.length`. It could not fail,
    // and so reported a skill pack on a machine with none.
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    rmSync(join(home, '.solix', 'skills'), { recursive: true, force: true });
    mkdirSync(join(home, '.solix', 'skills'), { recursive: true });
    // A loose file is not a skill either — skills are directories.
    writeFileSync(join(home, '.solix', 'skills', 'README.md'), '# not a skill\n');
    healthyServer();

    await doctor();

    expect(check('Solix skill pack').ok).toBe(false);
  });

  it('counts advisors by their .md files and ignores everything else', async () => {
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    writeFileSync(join(home, '.claude', 'agents', 'notes.txt'), 'not an agent\n');
    writeFileSync(join(home, '.claude', 'agents', 'cinder.md'), '# Cinder\n');
    healthyServer();

    await doctor();

    expect(check('Advisor agents installed').detail).toMatch(/^2 agents/);
  });

  it('says the server is unreachable without claiming anything about what it could not see', async () => {
    // The three probes that need a server must degrade to "unknown", not to a
    // verdict. Reporting "0 wrappers" or "Agent View unavailable" from a
    // failed fetch is inventing an answer.
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    noServer();

    await doctor();

    expect(check('Server reachable').ok).toBe(false);
    expect(check('Active solix run wrappers').detail).toMatch(/unknown/);
    expect(check('Agent View available').detail).toMatch(/unknown/);
    expect(process.exitCode).toBe(1);
  });

  it('reports a Node older than 20', async () => {
    const fake = { ...process, versions: { ...process.versions, node: '18.19.1' } };
    vi.stubGlobal('process', fake);
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    healthyServer();

    await doctor();

    const c = check('Node.js >= 20');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('18.19.1');
  });

  it('does not let native Windows cascade into a version failure', async () => {
    // On Windows the hooks cannot be written at all, so every hook-shaped
    // check goes red and the one actionable line — install under WSL — is
    // buried in noise. The platform line must be the only complaint.
    const fake = { ...process, platform: 'win32' };
    vi.stubGlobal('process', fake);
    const { doctor } = await load();
    healthyServer();

    await doctor();

    const platform = check('Platform supports hooks');
    expect(platform.ok).toBe(false);
    expect(platform.detail).toMatch(/WSL/);
    expect(check('Hooks match this version').ok).toBe(true);
  });

  it('probes the port it was given, not 4242', async () => {
    // The same defect as the gate's: `--port 5000` and the thing that is
    // supposed to tell you whether Solix is running looks somewhere else,
    // calls a healthy server down, and tells you to start the one that is
    // already up — where `solix start` would hit a port conflict.
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    const server = healthyServer(5000);

    await doctor({ port: 5000 });

    expect(check('Server reachable').ok).toBe(true);
    expect(server.urls.every((u) => u.includes(':5000'))).toBe(true);
    expect(process.exitCode).toBeUndefined();
  });

  it('still honours SOLIX_PORT when no port is passed', async () => {
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    vi.stubEnv('SOLIX_PORT', '7777');
    healthyServer(7777);

    await doctor();

    expect(check('Server reachable').ok).toBe(true);
  });

  it('ignores a SOLIX_PORT that is set but empty, instead of probing port 0', async () => {
    // `Number(process.env.SOLIX_PORT ?? 4242)` reads `SOLIX_PORT=` as 0,
    // because `??` only fires on null and undefined. A conditional CI step or
    // a half-filled .env was enough to make `solix doctor` probe
    // 127.0.0.1:0 and call a healthy server down.
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    vi.stubEnv('SOLIX_PORT', '');
    const server = healthyServer(4242);

    await doctor();

    expect(check('Server reachable').ok).toBe(true);
    expect(server.urls.join(' ')).not.toContain(':0/');
  });

  it('ignores a SOLIX_PORT that is not a port', async () => {
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    vi.stubEnv('SOLIX_PORT', 'auto');
    healthyServer(4242);

    await doctor();

    expect(check('Server reachable').ok).toBe(true);
  });

  it('says the port may be the problem when nothing answers on it', async () => {
    // "not running on http://127.0.0.1:4242" is a true statement that sends
    // someone to restart a server they are already running.
    const { doctor, HOOK_NAMES } = await load();
    fullInstall(HOOK_NAMES);
    noServer();

    await doctor();

    expect(text()).toMatch(/--port|SOLIX_PORT/);
  });
});
