import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hooksSupported, installedVersion } from './install.js';
import {
  CLAUDE_AGENTS_DIR,
  CLAUDE_BACKUP,
  CLAUDE_SETTINGS,
  HOOKS_DIR,
  HOOK_NAMES,
  SOLIX_HOME,
  SOLIX_INSTALL_STAMP,
  SOLIX_SKILLS_DIR,
} from './paths.js';

// Injected at build time by tsup, same define as index.ts.
declare const __SOLIX_VERSION__: string;

interface CheckResult {
  ok: boolean;
  label: string;
  detail?: string;
}

async function probeHealth(port: number): Promise<CheckResult> {
  const url = `http://127.0.0.1:${port}/api/health`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) {
      return { ok: false, label: 'Server reachable', detail: `HTTP ${res.status}` };
    }
    return { ok: true, label: 'Server reachable', detail: url };
  } catch (err) {
    return {
      ok: false,
      label: 'Server reachable',
      detail: `not running on ${url}`,
    };
  }
}

interface WrapperRecord {
  wrapperId: string;
  cwd: string;
}

async function probeWrappers(port: number): Promise<CheckResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/wrappers`, {
      signal: AbortSignal.timeout(800),
    });
    if (!res.ok) {
      return {
        ok: true,
        label: 'Active solix run wrappers',
        detail: 'server too old to report (pre-1.2.1)',
      };
    }
    const records = (await res.json()) as WrapperRecord[];
    return {
      ok: true,
      label: 'Active solix run wrappers',
      detail:
        records.length === 0
          ? 'none registered'
          : `${records.length} active`,
    };
  } catch {
    return {
      ok: true,
      label: 'Active solix run wrappers',
      detail: 'unknown — server unreachable',
    };
  }
}

interface PreflightResponse {
  claudeAvailable: boolean;
  version?: string;
  agentViewAvailable?: boolean;
}

async function probeAgentView(port: number): Promise<CheckResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/system/preflight`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) {
      return {
        ok: true,
        label: 'Agent View available',
        detail: 'server too old to report',
      };
    }
    const data = (await res.json()) as PreflightResponse;
    if (!data.claudeAvailable) {
      return {
        ok: false,
        label: 'Agent View available',
        detail: 'claude not on PATH',
      };
    }
    if (data.agentViewAvailable) {
      return {
        ok: true,
        label: 'Agent View available',
        detail: `yes (${data.version ?? 'unknown version'})`,
      };
    }
    return {
      ok: true,
      label: 'Agent View available',
      detail: `no — need Claude Code 2.1.139+ (have ${data.version ?? '?'})`,
    };
  } catch {
    return {
      ok: true,
      label: 'Agent View available',
      detail: 'unknown — server unreachable',
    };
  }
}

export async function doctor(): Promise<void> {
  const port = Number(process.env.SOLIX_PORT ?? 4242);
  const checks: CheckResult[] = [];

  const nodeVersion = process.versions.node;
  const major = Number(nodeVersion.split('.')[0]);
  checks.push({
    ok: major >= 20,
    label: 'Node.js >= 20',
    detail: `v${nodeVersion}`,
  });

  checks.push({
    ok: existsSync(SOLIX_HOME),
    label: 'Solix home directory',
    detail: SOLIX_HOME,
  });

  // Report this before the hook checks, because on Windows it is the reason
  // all of them fail and every other line below is a distraction.
  checks.push({
    ok: hooksSupported(),
    label: 'Platform supports hooks',
    detail: hooksSupported()
      ? process.platform
      : 'native Windows — hooks are POSIX shell; run Solix inside WSL',
  });

  checks.push({
    ok: true,
    label: 'Versions',
    detail: `solix ${__SOLIX_VERSION__} · node ${process.version} · ${process.platform}`,
  });

  checks.push({
    ok: installedVersion() === __SOLIX_VERSION__ || !hooksSupported(),
    label: 'Hooks match this version',
    detail:
      installedVersion() === __SOLIX_VERSION__
        ? `stamped ${installedVersion()}`
        : `stamped ${installedVersion() ?? 'unstamped'}, running ${__SOLIX_VERSION__} — restart solix to update`,
  });

  let allHooksPresent = true;
  const missing: string[] = [];
  for (const name of HOOK_NAMES) {
    const p = join(HOOKS_DIR, `${name}.sh`);
    if (!existsSync(p)) {
      allHooksPresent = false;
      missing.push(name);
      continue;
    }
    try {
      statSync(p);
    } catch {
      allHooksPresent = false;
      missing.push(name);
    }
  }
  checks.push({
    ok: allHooksPresent,
    label: 'Hook scripts installed',
    detail: allHooksPresent
      ? `${HOOK_NAMES.length} scripts in ${HOOKS_DIR}`
      : `missing: ${missing.join(', ')}`,
  });

  checks.push({
    ok: existsSync(CLAUDE_SETTINGS),
    label: 'Claude settings.json present',
    detail: CLAUDE_SETTINGS,
  });

  /**
   * Red on a perfectly healthy machine, until now.
   *
   * install() only takes a backup when a settings.json already existed —
   * there is nothing to preserve otherwise. So a clean first install had no
   * backup, this reported ✗ "not yet created", set exit 1, and told the
   * user to run `solix install`, which could never produce one. A health
   * check that is permanently red on a healthy machine teaches people to
   * ignore health checks, which is worse than not having it.
   *
   * The stamp distinguishes the two cases: present means install() ran, so
   * no backup means there was nothing to back up.
   */
  const hasBackup = existsSync(CLAUDE_BACKUP);
  const everInstalled = existsSync(SOLIX_INSTALL_STAMP);
  checks.push({
    ok: hasBackup || everInstalled,
    label: 'Backup of settings.json',
    detail: hasBackup
      ? CLAUDE_BACKUP
      : everInstalled
        ? 'not needed — you had no settings.json before Solix'
        : 'not yet created — run `solix install`',
  });

  let advisorCount = 0;
  if (existsSync(CLAUDE_AGENTS_DIR)) {
    try {
      advisorCount = readdirSync(CLAUDE_AGENTS_DIR).filter((f) =>
        f.endsWith('.md'),
      ).length;
    } catch {
      advisorCount = 0;
    }
  }
  checks.push({
    ok: advisorCount > 0,
    label: 'Advisor agents installed',
    detail:
      advisorCount > 0
        ? `${advisorCount} agents in ${CLAUDE_AGENTS_DIR}`
        : 'none yet — run `solix install`',
  });

  let skillCount = 0;
  if (existsSync(SOLIX_SKILLS_DIR)) {
    try {
      skillCount = readdirSync(SOLIX_SKILLS_DIR).filter((entry) => {
        try {
          return statSync(join(SOLIX_SKILLS_DIR, entry)).isDirectory();
        } catch {
          return false;
        }
      }).length;
    } catch {
      skillCount = 0;
    }
  }
  // `skillCount >= 0` on a .length — a check that could not fail, and so
  // reported health it had never established.
  checks.push({
    ok: skillCount > 0,
    label: 'Solix skill pack',
    detail:
      skillCount > 0
        ? `${skillCount} skills in ${SOLIX_SKILLS_DIR}`
        : `none in ${SOLIX_SKILLS_DIR} — run \`solix install\``,
  });

  checks.push(await probeHealth(port));
  checks.push(await probeWrappers(port));
  checks.push(await probeAgentView(port));

  console.log('\nSolix Diagnostics\n');
  let allOk = true;
  for (const c of checks) {
    const icon = c.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const detail = c.detail ? `  \x1b[2m${c.detail}\x1b[0m` : '';
    console.log(`${icon} ${c.label}${detail}`);
    if (!c.ok) allOk = false;
  }
  console.log('');
  if (allOk) {
    console.log('All checks passed. Solix is healthy.\n');
  } else {
    console.log(
      'Some checks failed. Run `solix install` and `solix start` to fix common issues.\n',
    );
    process.exitCode = 1;
  }
}
