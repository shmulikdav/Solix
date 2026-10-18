import { createSolixServer } from '@solix/server/create';
import open from 'open';
import {
  claudeCodePresent,
  hooksInstalled,
  hooksSupported,
  hooksUpToDate,
  install,
  installedVersion,
} from './install.js';

// Injected at build time by tsup (same define as index.ts). Lets the
// server report the real product version at /api/health instead of a
// stale hardcoded literal.
declare const __SOLIX_VERSION__: string;

export interface StartOptions {
  port?: number;
  noOpen?: boolean;
}

// Standard FIGlet font, S O L I X. The previous banner accidentally
// drew an "M" as the last letter (SOLIM) — corrected here.
const BANNER = `
   ____   ___  _     ___ __  __
  / ___| / _ \\| |   |_ _|\\ \\/ /
  \\___ \\| | | | |    | |  \\  /
   ___) | |_| | |___ | |  /  \\
  |____/ \\___/|_____|___|/_/\\_\\

  a solar-system command center for Claude Code
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
function ensureWired(): void {
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

  console.log(
    stale
      ? `[solix] hooks are from ${installedVersion() ?? 'an older release'} — updating to ${__SOLIX_VERSION__}`
      : '[solix] first run — wiring Claude Code hooks',
  );
  try {
    install();
    console.log('[solix] undo any time with `solix uninstall`');
  } catch (err) {
    console.warn(
      `[solix] could not wire hooks automatically: ${String(err)}\n` +
        '        Run `solix install` to do it by hand, then `solix doctor`.',
    );
  }
}

export async function start(opts: StartOptions = {}): Promise<void> {
  const port = opts.port ?? Number(process.env.SOLIX_PORT ?? 4242);
  console.log(BANNER);
  ensureWired();
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

  const shutdown = async (sig: string): Promise<void> => {
    console.log(`\n[solix] ${sig} — shutting down`);
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
