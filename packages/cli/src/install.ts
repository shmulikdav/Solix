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
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  CLAUDE_AGENTS_DIR,
  CLAUDE_BACKUP,
  CLAUDE_DIR,
  CLAUDE_PREV_BACKUP,
  CLAUDE_SETTINGS,
  HOOK_NAMES,
  HOOKS_DIR,
  SOLIX_HOME,
  SOLIX_AGENTS_MANIFEST,
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

/**
 * Thrown when `~/.claude/settings.json` exists but cannot be read as a JSON
 * object, so Solix has no idea what is in it.
 *
 * Its own class because the one thing callers must not do is carry on. See
 * `readSettings` for why.
 */
export class SettingsUnreadableError extends Error {
  constructor(readonly detail: string) {
    super(
      `${CLAUDE_SETTINGS} could not be parsed, so nothing was changed.\n` +
        `        ${detail}\n` +
        '        Solix merges its hooks into that file. It will not overwrite a\n' +
        '        file it cannot read, because that would discard whatever else\n' +
        '        is in it — permissions, env, model, MCP servers. Fix the JSON\n' +
        '        (or move it aside) and run Solix again.',
    );
    this.name = 'SettingsUnreadableError';
  }
}

type SettingsRead =
  | { ok: true; settings: ClaudeSettings }
  | { ok: false; detail: string };

/**
 * Read the user's Claude Code settings, or say why not.
 *
 * This returned `{}` on a parse failure and logged a warning. The warning was
 * line 3 of sixteen identical `[solix]` lines and the `{}` went straight into
 * `{ ...existing, hooks: merged }` — so one trailing comma in the user's
 * settings.json replaced their permissions, env, model, apiKeyHelper,
 * statusLine and MCP config with Solix's hooks alone, and then printed
 * "merged hooks into ..." as though it had merged. The backup only covered
 * the first such write, because it is taken once and never refreshed.
 *
 * `uninstall.ts` already argues the general case and gets it right:
 * uninstalling a tool is not consent to roll back a config file the tool
 * does not own. Neither is installing one. A file we cannot parse is a file
 * we must not write.
 *
 * An absent file is not an error — there is nothing to lose, and a fresh
 * install is the common case. Nor is an empty one: Claude Code treats
 * whitespace as no settings, so we do too.
 */
function readSettings(): SettingsRead {
  if (!existsSync(CLAUDE_SETTINGS)) return { ok: true, settings: {} };
  let txt: string;
  try {
    txt = readFileSync(CLAUDE_SETTINGS, 'utf8');
  } catch (err) {
    return { ok: false, detail: `could not read it: ${String(err)}` };
  }
  if (txt.trim() === '') return { ok: true, settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(txt);
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
  // A top-level array or scalar parses but is not settings. Spreading it
  // would produce an object with numeric keys and silently drop the rest.
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, detail: 'it parsed, but it is not a JSON object.' };
  }
  return { ok: true, settings: parsed as ClaudeSettings };
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

  // Which of these files we installed last time. Anything on disk that is
  // NOT in here belongs to the user, and overwriting it unannounced is how
  // someone loses an agent they wrote. There are fifteen advisors, so
  // fifteen possible collisions.
  const ours = readAgentsManifest();
  const installed: string[] = [];
  const displaced: string[] = [];
  let copied = 0;

  for (const a of manifest.advisors) {
    const from = join(src, a.agentMd);
    const to = join(CLAUDE_AGENTS_DIR, a.agentMd);
    if (!existsSync(from)) continue;

    if (existsSync(to) && !ours.includes(a.agentMd)) {
      // Preserve it once. A second install must not overwrite the backup
      // with our own copy of the file.
      const aside = `${to}.pre-solix.bak`;
      if (!existsSync(aside)) copyFileSync(to, aside);
      displaced.push(a.agentMd);
    }

    copyFileSync(from, to);
    installed.push(a.agentMd);
    copied += 1;
  }

  writeAgentsManifest(installed);

  if (displaced.length > 0) {
    console.log(
      `[solix] ${displaced.length} agent file(s) in ${CLAUDE_AGENTS_DIR} had the\n` +
        `        same name as a Solix advisor: ${displaced.join(', ')}\n` +
        '        Yours were copied to <name>.md.pre-solix.bak first.',
    );
  }
  return copied;
}

/** Filenames Solix has installed into `~/.claude/agents`, or none. */
export function readAgentsManifest(): string[] {
  if (!existsSync(SOLIX_AGENTS_MANIFEST)) return [];
  try {
    const parsed = JSON.parse(
      readFileSync(SOLIX_AGENTS_MANIFEST, 'utf8'),
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is string => typeof n === 'string');
  } catch {
    // A corrupt manifest means we no longer know which files are ours, and
    // guessing would risk deleting the user's. Treat it as "none are ours".
    return [];
  }
}

function writeAgentsManifest(names: string[]): void {
  mkdirSync(SOLIX_HOME, { recursive: true });
  writeFileSync(SOLIX_AGENTS_MANIFEST, JSON.stringify(names, null, 2) + '\n');
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

/**
 * Can this platform run Solix's hooks at all?
 *
 * The hooks are POSIX `sh` and lean on `$PPID`, `date +%s`, `pwd` and `curl`.
 * Native Windows `cmd` cannot execute them, so on win32 they are written,
 * registered, and then never fire — the user watches an empty galaxy with
 * nothing saying why. Better to decline loudly.
 *
 * Rewriting them in Node would be portable but is not free: measured here,
 * `sh` starts in ~2ms and `node` in ~37ms, and PreToolUse/PostToolUse fire on
 * every single tool call, in the agent's blocking path. Paying ~70ms per tool
 * call on every platform to serve one is the wrong trade; the right fix is
 * native `.cmd` hooks, verified by someone actually on Windows.
 *
 * WSL reports as linux, so Windows users have a working path today.
 */
export function hooksSupported(): boolean {
  return process.platform !== 'win32';
}

/** Has Claude Code ever run on this machine? (i.e. is there a config to merge into) */
export function claudeCodePresent(): boolean {
  return existsSync(CLAUDE_DIR);
}

/**
 * Is the `claude` binary on this machine, whether or not it has ever run?
 *
 * `claudeCodePresent()` answers "is there a config directory", which is a
 * different question, and `start` was using it to decide whether to print
 * "Claude Code not detected — … install Claude Code and restart Solix".
 * Install Claude Code, run `solix` before you have ever run `claude`, and
 * the product told you to install software you had just installed, wired
 * nothing, and left you watching an empty galaxy. Found by walking the
 * partner brief's own install sequence against a packed tarball.
 *
 * `~/.claude` not existing yet is not a reason to decline: Claude Code reads
 * that directory on its first run, so writing the settings there is exactly
 * what wiring means. Declining is only right when the binary is absent too.
 *
 * Honours `SOLIX_CLAUDE_BIN` for the same reason the launcher does — under
 * nvm or a version manager, `claude` may not be on the PATH Solix inherits,
 * and the brief already tells people to set it.
 */
export function claudeBinaryPresent(): boolean {
  const override = (process.env.SOLIX_CLAUDE_BIN ?? '').trim();
  if (override) return existsSync(override);
  const probe =
    process.platform === 'win32'
      ? spawnSync('where', ['claude'], { encoding: 'utf8', timeout: 3000 })
      : spawnSync('command', ['-v', 'claude'], {
          encoding: 'utf8',
          timeout: 3000,
          shell: true,
        });
  return probe.status === 0 && Boolean((probe.stdout ?? '').trim());
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
  const read = readSettings();
  // Unreadable counts as not wired, so `install()` runs and fails with the
  // explanation rather than this predicate swallowing it as a false.
  if (!read.ok) return false;
  const wired = JSON.stringify(read.settings.hooks ?? {});
  return wired.includes(HOOKS_DIR);
}

export interface InstallOptions {
  force?: boolean;
}

export function install(opts: InstallOptions = {}): void {
  mkdirSync(SOLIX_HOME, { recursive: true });
  mkdirSync(CLAUDE_DIR, { recursive: true });

  // First, before touching anything: if we cannot read what is already
  // there, we cannot merge into it, and overwriting it would lose it.
  const read = readSettings();
  if (!read.ok) throw new SettingsUnreadableError(read.detail);
  const existing = read.settings;

  if (existsSync(CLAUDE_SETTINGS)) {
    // CLAUDE_BACKUP is the pre-Solix state and `uninstall` restores from it,
    // so it is written once and never refreshed — refreshing it on an
    // upgrade would make "restore my original settings" restore a file Solix
    // wrote. CLAUDE_PREV_BACKUP is the other half: the file as it was
    // immediately before this write, which is what you want after an
    // upgrade goes wrong.
    // Deliberately not refreshed by --force. --force means "re-install the
    // hooks even though some are present"; it used to also overwrite this
    // file, which is the only copy of the user's pre-Solix settings and the
    // one `uninstall` restores.
    if (!existsSync(CLAUDE_BACKUP)) {
      copyFileSync(CLAUDE_SETTINGS, CLAUDE_BACKUP);
      console.log(`[solix] backed up settings.json -> ${CLAUDE_BACKUP}`);
    }
    copyFileSync(CLAUDE_SETTINGS, CLAUDE_PREV_BACKUP);
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
