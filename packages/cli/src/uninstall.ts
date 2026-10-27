import {
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CLAUDE_AGENTS_DIR,
  CLAUDE_BACKUP,
  CLAUDE_SETTINGS,
  HOOKS_DIR,
  SOLIX_AGENTS_MANIFEST,
  SOLIX_INSTALL_STAMP,
  SOLIX_SKILLS_DIR,
} from './paths.js';
import { readAgentsManifest } from './install.js';
import { uninstallShim } from './install-shim.js';

interface HookEntry {
  matcher: string;
  hooks: { type: 'command'; command: string }[];
}

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}

/**
 * Remove Solix from Claude Code's settings.
 *
 * This used to restore the backup wholesale whenever one existed. The backup
 * is taken ONCE, at first install, so that quietly reverted every change the
 * user had made to settings.json since — their own hooks, MCP servers,
 * permissions, env. Uninstalling a tool is not consent to roll back a config
 * file the tool does not own, and "I removed it and it wiped my Claude setup"
 * is the kind of thing a beta tester tells other people.
 *
 * So: always remove surgically, taking out only the entries pointing at
 * Solix's own hooks directory. The backup is a last resort for the one case
 * surgery cannot handle — settings.json no longer parsing.
 *
 * That reasoning covered settings.json and nothing else, while `install`
 * also writes fifteen advisor files into `~/.claude/agents` — a directory
 * Claude Code owns and the user may have their own agents in. Those were
 * left behind, which made `start`'s "undo any time with `solix uninstall`"
 * untrue: unregistering the hooks left fifteen agent definitions in every
 * future Claude session. They are removed here, by name, from the manifest
 * `install` writes — never by pattern, so an agent the user wrote with a
 * colliding name is not collateral.
 *
 * The database is deliberately left alone. It holds the user's session and
 * cost history, and deleting it to uninstall a wrapper would be its own
 * data-loss bug.
 */
export function uninstall(): void {
  // Always try to remove the shell shim first — independent of the
  // hooks state. A user could have one but not the other.
  uninstallShim();

  if (!existsSync(CLAUDE_SETTINGS)) {
    console.log('[solix] nothing to uninstall (no settings.json found)');
    return;
  }

  let cur: ClaudeSettings | null = null;
  try {
    cur = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8')) as ClaudeSettings;
  } catch {
    cur = null;
  }

  if (cur === null) {
    // Unparseable: there is nothing to operate on, so the install-time
    // snapshot really is the best available outcome. Say so, because it may
    // discard later edits and the user should know which path ran.
    if (existsSync(CLAUDE_BACKUP)) {
      copyFileSync(CLAUDE_BACKUP, CLAUDE_SETTINGS);
      console.log(
        `[solix] settings.json could not be parsed — restored the copy taken\n` +
          `        at install time. Changes made since then are not in it.`,
      );
      return;
    }
    console.log(
      '[solix] settings.json could not be parsed and there is no backup —\n' +
        '        leaving it untouched. Remove the solix hook entries by hand.',
    );
    return;
  }

  if (cur.hooks) {
    for (const [evt, entries] of Object.entries(cur.hooks)) {
      cur.hooks[evt] = entries.filter(
        (e) => !e.hooks.some((h) => h.command.includes(HOOKS_DIR)),
      );
      if (cur.hooks[evt].length === 0) delete cur.hooks[evt];
    }
  }
  writeFileSync(CLAUDE_SETTINGS, JSON.stringify(cur, null, 2) + '\n');
  console.log(`[solix] removed Solix hooks from ${CLAUDE_SETTINGS}`);

  removeInstalledFiles();
}

/**
 * Remove the files `install` put outside `~/.solix`, plus our own hook
 * scripts and stamp. Everything here is best-effort: a file already gone is
 * success, and a permission error should not abort an uninstall that has
 * already unregistered the hooks.
 */
function removeInstalledFiles(): void {
  const agents = readAgentsManifest();
  let removed = 0;
  for (const name of agents) {
    const target = join(CLAUDE_AGENTS_DIR, name);
    try {
      if (existsSync(target)) {
        unlinkSync(target);
        removed += 1;
      }
      // If we displaced one of the user's own agents, put it back.
      const aside = `${target}.pre-solix.bak`;
      if (existsSync(aside)) {
        copyFileSync(aside, target);
        unlinkSync(aside);
        console.log(`[solix] restored your own ${name}`);
      }
    } catch {
      /* best effort */
    }
  }
  if (removed > 0) {
    console.log(
      `[solix] removed ${removed} advisor agent file(s) from ${CLAUDE_AGENTS_DIR}`,
    );
  }

  for (const path of [HOOKS_DIR, SOLIX_SKILLS_DIR]) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  for (const path of [SOLIX_AGENTS_MANIFEST, SOLIX_INSTALL_STAMP]) {
    try {
      rmSync(path, { force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(
    '[solix] your session history is kept in ~/.solix/solix.db — delete that\n' +
      '        directory by hand if you want it gone too.',
  );
}
