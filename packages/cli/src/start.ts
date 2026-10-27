import { createSolixServer } from '@solix/server/create';
import { getDb } from '@solix/server/db';
import {
  describeGovernanceLevel,
  getGovernanceLevel,
} from '@solix/server/governance';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import open from 'open';
import {
  SettingsUnreadableError,
  claudeCodePresent,
  hooksInstalled,
  hooksSupported,
  hooksUpToDate,
  install,
  installedVersion,
} from './install.js';
import {
  CLAUDE_AGENTS_DIR,
  CLAUDE_SETTINGS,
  HOOK_NAMES,
} from './paths.js';

// Injected at build time by tsup (same define as index.ts). Lets the
// server report the real product version at /api/health instead of a
// stale hardcoded literal.
declare const __SOLIX_VERSION__: string;

export interface StartOptions {
  port?: number;
  noOpen?: boolean;
  /** Skip wiring Claude Code. Real sessions will not appear. */
  noWire?: boolean;
}

// Standard FIGlet font, S O L I X. The previous banner accidentally
// drew an "M" as the last letter (SOLIM) — corrected here.
const BANNER = `
   ____   ___  _     ___ __  __
  / ___| / _ \\| |   |_ _|\\ \\/ /
  \\___ \\| | | | |    | |  \\  /
   ___) | |_| | |___ | |  /  \\
  |____/ \\___/|_____|___|/_/\\_\\

  the control layer for your coding agents
`;

/**
 * Wire Solix into Claude Code on first run.
 *
 * This used to be a separate `solix install` step, and skipping it failed
 * silently in the worst way: the server started, the browser opened, and the
 * banner said "start any `claude` session to see your first planet appear" —
 * which never happened, with no error to explain it. Installing Solix is
 * consent to set Solix up, the change is backed up and merged rather than
 * overwritten, and `solix uninstall` reverses it, so the step is done rather
 * than demanded.
 */
function ensureWired(noWire = false): void {
  if (noWire) {
    console.log(
      '[solix] --no-wire: leaving Claude Code alone. Real sessions will not\n' +
        '        appear here; `solix demo` works, and `solix install` wires it\n' +
        '        when you want it.',
    );
    return;
  }

  // Say it before doing anything. Writing hooks that cannot execute would
  // leave a user staring at an empty galaxy with the UI insisting all is
  // well — the exact silent failure this whole function exists to end.
  if (!hooksSupported()) {
    console.log(
      '[solix] native Windows is not supported yet — the hooks are POSIX\n' +
        '        shell scripts, so real Claude Code sessions will not appear.\n' +
        '        Run Solix inside WSL and it works today; `solix demo` works\n' +
        '        here as-is.',
    );
    return;
  }

  if (hooksUpToDate()) return;

  // Hooks are present but were written by a different release. The scripts
  // ship with the product and change between versions, so leaving them is
  // how a user ends up running last release's hooks against this release's
  // server — and never finds out.
  const stale = hooksInstalled();

  if (!claudeCodePresent()) {
    // Nothing to wire into, and that is a legitimate state — the demo runs
    // without Claude Code. Say so once instead of creating a config
    // directory for software that is not installed.
    console.log(
      '[solix] Claude Code not detected — no hooks wired.\n' +
        '        Run `solix demo` to explore, or install Claude Code and\n' +
        '        restart Solix to watch real sessions.',
    );
    return;
  }

  // On first run, say what is about to be written before writing it.
  // "first run — wiring Claude Code hooks" was true and far too small: the
  // install registers hooks that run in the blocking path of every tool call
  // of every Claude Code session on the machine, and copies fifteen agent
  // files into a directory Claude Code owns. Someone who curates their agent
  // list, or who cares what runs on every Bash call, would like to have been
  // told — and to be able to decline.
  console.log(
    stale
      ? `[solix] hooks are from ${installedVersion() ?? 'an older release'} — updating to ${__SOLIX_VERSION__}`
      : '[solix] first run — about to wire Claude Code:\n' +
          `        • ${HOOK_NAMES.length} hooks into ${CLAUDE_SETTINGS}, backed up first.\n` +
          '          Two of them run on every tool call of every Claude Code\n' +
          '          session, in the agent\'s blocking path (~2ms each).\n' +
          `        • advisor agents into ${CLAUDE_AGENTS_DIR}. An agent of yours\n` +
          '          with the same name is kept as <name>.md.pre-solix.bak.\n' +
          '        • hook scripts and skills under ~/.solix.\n' +
          '        `solix uninstall` removes all of it. To skip it for now,\n' +
          '        stop here and run `solix start --no-wire`.',
  );
  try {
    install();
    console.log('[solix] undo any time with `solix uninstall`');
  } catch (err) {
    // An unreadable settings.json already explains itself, and its fix is
    // not "run the same thing by hand" — that fails identically. Print it
    // as-is rather than burying it under generic advice.
    if (err instanceof SettingsUnreadableError) {
      console.warn(`[solix] ${err.message}`);
      return;
    }
    console.warn(
      `[solix] could not wire hooks automatically: ${String(err)}\n` +
        '        Run `solix install` to do it by hand, then `solix doctor`.',
    );
  }
}

export async function start(opts: StartOptions = {}): Promise<void> {
  const port = opts.port ?? Number(process.env.SOLIX_PORT ?? 4242);
  console.log(BANNER);
  ensureWired(opts.noWire);
  const handle = await createSolixServer({
    port,
    version: __SOLIX_VERSION__,
    // The CLI owns the install, so it is the only thing that can honestly
    // answer "are the hooks wired, and are they this version's". Without it
    // a bug report cannot distinguish "broken" from "never set up".
    hookStatus: () => ({
      installed: hooksInstalled(),
      upToDate: hooksUpToDate(),
      stampedVersion: installedVersion(),
      claudeCodePresent: claudeCodePresent(),
      supported: hooksSupported(),
    }),
  });
  const url = `http://${handle.hostname}:${handle.port}`;
  console.log(`[solix] server listening on ${url}`);
  console.log(`[solix] events  -> POST ${url}/events`);
  console.log(`[solix] ws      -> ws://${handle.hostname}:${handle.port}/ws`);
  if (!opts.noOpen) {
    try {
      await open(url);
    } catch {
      console.log(`[solix] open ${url} in your browser to view`);
    }
  }
  console.log(
    claudeCodePresent() && hooksSupported()
      ? '[solix] start any `claude` session to see your first planet appear'
      : '[solix] run `solix demo` to see a galaxy without Claude Code',
  );
  announceGovernance();
  offerImportWhenEmpty();

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\n[solix] ${sig} — shutting down`);
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * State the posture on startup.
 *
 * "How supervised am I right now" should never need looking up — it is the
 * one thing this product is for, and a level someone set weeks ago and
 * forgot is exactly how a surprise happens.
 */
function announceGovernance(): void {
  try {
    const current = getGovernanceLevel(getDb());
    console.log(`[solix] governance: ${describeGovernanceLevel(current)}`);
  } catch {
    // Never fail startup over a status line.
  }
}

/**
 * Point at `solix import` when the galaxy would open empty.
 *
 * Solix only sees sessions started after its hooks were wired, so a first
 * run shows nothing however much work is already on disk — the worst
 * possible first screen for a tool about watching your fleet. Say so once,
 * and only when it is true: there is history to import and nothing in the
 * database yet.
 *
 * It suggests rather than imports. Reading someone's transcripts is
 * harmless, but doing it unasked on first launch is not the impression to
 * make.
 */
function offerImportWhenEmpty(): void {
  try {
    const db = getDb();
    const { n } = db
      .prepare(`SELECT COUNT(*) AS n FROM sessions`)
      .get() as { n: number };
    if (n > 0) return;

    const base = join(homedir(), '.claude', 'projects');
    if (!existsSync(base)) return;
    const hasHistory = readdirSync(base).some((p) => {
      try {
        return readdirSync(join(base, p)).some((f) => f.endsWith('.jsonl'));
      } catch {
        return false;
      }
    });
    if (!hasHistory) return;

    console.log(
      '[solix] the galaxy is empty, but you have Claude Code history —\n' +
        '        run `solix import` to bring it in',
    );
  } catch {
    // A hint is never worth failing startup over.
  }
}
