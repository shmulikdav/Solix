import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  CLAUDE_AGENTS_DIR,
  CLAUDE_BACKUP,
  CLAUDE_DIR,
  CLAUDE_SETTINGS,
  HOOK_NAMES,
  HOOKS_DIR,
  SOLIX_HOME,
  SOLIX_INSTALL_STAMP,
  SOLIX_SKILLS_DIR,
  SOLIX_TOKEN_FILE,
  packagedAgentsDir,
  packagedHooksDir,
  packagedSkillsDir,
} from './paths.js';

interface HookEntry {
  matcher: string;
  hooks: { type: 'command'; command: string }[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

function readSettings(): ClaudeSettings {
  if (!existsSync(CLAUDE_SETTINGS)) return {};
  try {
    const txt = readFileSync(CLAUDE_SETTINGS, 'utf8');
    return JSON.parse(txt) as ClaudeSettings;
  } catch (err) {
    console.warn(`[solix] could not parse ${CLAUDE_SETTINGS}: ${String(err)}`);
    return {};
  }
}

function hookCommand(name: string): string {
  return `${HOOKS_DIR}/${name}.sh`;
}

function buildSolixHooks(): Record<string, HookEntry[]> {
  return {
    SessionStart: [
      { matcher: '*', hooks: [{ type: 'command', command: hookCommand('session-start') }] },
    ],
    UserPromptSubmit: [
      { matcher: '*', hooks: [{ type: 'command', command: hookCommand('prompt-submit') }] },
    ],
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand('stop') }] }],
    SubagentStop: [
      { matcher: '*', hooks: [{ type: 'command', command: hookCommand('subagent-stop') }] },
    ],
    PreToolUse: [
      { matcher: 'Task', hooks: [{ type: 'command', command: hookCommand('pre-tool-task') }] },
      {
        matcher: 'Read|Write|Edit|MultiEdit',
        hooks: [{ type: 'command', command: hookCommand('pre-tool-file') }],
      },
      { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('pre-tool-bash') }] },
    ],
    PostToolUse: [
      { matcher: '*', hooks: [{ type: 'command', command: hookCommand('post-tool') }] },
    ],
    Notification: [
      { matcher: '*', hooks: [{ type: 'command', command: hookCommand('notification') }] },
    ],
  };
}

function isSolixHook(entry: HookEntry): boolean {
  return entry.hooks.some((h) => h.command.includes(`${HOOKS_DIR}/`));
}

function mergeHooks(
  existing: Record<string, HookEntry[]> | undefined,
  solix: Record<string, HookEntry[]>,
): Record<string, HookEntry[]> {
  const merged: Record<string, HookEntry[]> = { ...(existing ?? {}) };
  for (const [evt, solixEntries] of Object.entries(solix)) {
    const userEntries = (merged[evt] ?? []).filter((e) => !isSolixHook(e));
    merged[evt] = [...userEntries, ...solixEntries];
  }
  return merged;
}

/**
 * Generate a per-machine shared secret once and persist it (0600). Hooks read
 * it and send it as X-Solix-Token; the server requires it on /events. Idempotent
 * — keeps the existing token so re-running install (or --force) doesn't break
 * already-wired hooks.
 */
function ensureToken(): void {
  if (existsSync(SOLIX_TOKEN_FILE)) return;
  const token = randomBytes(24).toString('hex');
  writeFileSync(SOLIX_TOKEN_FILE, token, { mode: 0o600 });
  try {
    chmodSync(SOLIX_TOKEN_FILE, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

function installHookScripts(): void {
  mkdirSync(HOOKS_DIR, { recursive: true });
  const src = packagedHooksDir();
  if (!existsSync(src)) {
    throw new Error(
      `Solix hook scripts not found at ${src}. Did the package build correctly?`,
    );
  }
  for (const name of HOOK_NAMES) {
    const from = join(src, `${name}.sh`);
    const to = join(HOOKS_DIR, `${name}.sh`);
    copyFileSync(from, to);
    chmodSync(to, 0o755);
  }
}

interface ManifestAdvisor {
  id: string;
  agentMd: string;
}

function installAdvisorAgents(): number {
  const src = packagedAgentsDir();
  if (!existsSync(src)) {
    console.warn(`[solix] no advisors/ directory at ${src}; skipping`);
    return 0;
  }
  const manifestPath = join(src, 'manifest.json');
  if (!existsSync(manifestPath)) return 0;
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    advisors: ManifestAdvisor[];
  };
  mkdirSync(CLAUDE_AGENTS_DIR, { recursive: true });
  let copied = 0;
  for (const a of manifest.advisors) {
    const from = join(src, a.agentMd);
    const to = join(CLAUDE_AGENTS_DIR, a.agentMd);
    if (!existsSync(from)) continue;
    copyFileSync(from, to);
    copied += 1;
  }
  return copied;
}

function installSolixSkills(): number {
  const src = packagedSkillsDir();
  if (!existsSync(src)) return 0;
  mkdirSync(SOLIX_SKILLS_DIR, { recursive: true });
  let copied = 0;
  for (const entry of readdirSync(src)) {
    const fromDir = join(src, entry);
    let isDir = false;
    try {
      isDir = statSync(fromDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const toDir = join(SOLIX_SKILLS_DIR, entry);
    cpSync(fromDir, toDir, { recursive: true });
    copied += 1;
  }
  return copied;
}

// Injected at build time by tsup, same define as index.ts / start.ts.
declare const __SOLIX_VERSION__: string;

/** Has Claude Code ever run on this machine? */
export function claudeCodePresent(): boolean {
  return existsSync(CLAUDE_DIR);
}

/**
 * Which Solix version wrote the hooks currently on disk, or null if they
 * predate the stamp (or were never written).
 */
export function installedVersion(): string | null {
  try {
    const v = readFileSync(SOLIX_INSTALL_STAMP, 'utf8').trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Are the hooks on disk the ones this build ships?
 *
 * "Do the files exist" is not enough. The hook scripts are part of the
 * product and change between releases, so an existence check means an
 * upgrade never rewrites them: `solix start` sees "installed", skips, and the
 * user keeps running the previous release's hooks for good. In a beta, where
 * the whole point is shipping fixes, that turns every fix into "it's still
 * broken" with no way for either side to tell why.
 */
export function hooksUpToDate(): boolean {
  return hooksInstalled() && installedVersion() === __SOLIX_VERSION__;
}

/**
 * Are Solix's hooks actually in place?
 *
 * Both halves have to be true: the scripts must exist on disk, and Claude
 * Code's settings must point at them. Checking only one of them is how you
 * get the failure this guards — `solix start` printed "start any claude
 * session to see your first planet appear" whether or not anything was wired,
 * so a user with no hooks watched an empty galaxy forever with nothing
 * explaining why.
 */
export function hooksInstalled(): boolean {
  for (const name of HOOK_NAMES) {
    if (!existsSync(join(HOOKS_DIR, `${name}.sh`))) return false;
  }
  if (!existsSync(CLAUDE_SETTINGS)) return false;
  const settings = readSettings();
  const wired = JSON.stringify(settings.hooks ?? {});
  return wired.includes(HOOKS_DIR);
}

export interface InstallOptions {
  force?: boolean;
}

export function install(opts: InstallOptions = {}): void {
  mkdirSync(SOLIX_HOME, { recursive: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });

  const existing = readSettings();
  if (existsSync(CLAUDE_SETTINGS) && !existsSync(CLAUDE_BACKUP)) {
    copyFileSync(CLAUDE_SETTINGS, CLAUDE_BACKUP);
    console.log(`[solix] backed up settings.json -> ${CLAUDE_BACKUP}`);
  } else if (opts.force && existsSync(CLAUDE_SETTINGS)) {
    copyFileSync(CLAUDE_SETTINGS, CLAUDE_BACKUP);
  }

  ensureToken();

  installHookScripts();
  console.log(`[solix] installed hook scripts in ${HOOKS_DIR}`);

  const advisorsCopied = installAdvisorAgents();
  if (advisorsCopied > 0) {
    console.log(
      `[solix] installed ${advisorsCopied} advisor agents in ${CLAUDE_AGENTS_DIR}`,
    );
  }

  const skillsCopied = installSolixSkills();
  if (skillsCopied > 0) {
    console.log(
      `[solix] installed ${skillsCopied} Solix skills in ${SOLIX_SKILLS_DIR}`,
    );
  }

  const merged = mergeHooks(existing.hooks, buildSolixHooks());
  const next: ClaudeSettings = { ...existing, hooks: merged };
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(next, null, 2) + '\n');
  console.log(`[solix] merged hooks into ${CLAUDE_SETTINGS}`);

  // Last, and only on success: the stamp is what lets a later start tell
  // "these hooks are current" from "these hooks are from two releases ago".
  // Writing it before the work above would claim an install that failed.
  writeFileSync(SOLIX_INSTALL_STAMP, `${__SOLIX_VERSION__}\n`);
}
