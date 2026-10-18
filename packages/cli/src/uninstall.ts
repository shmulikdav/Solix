import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { CLAUDE_BACKUP, CLAUDE_SETTINGS, HOOKS_DIR } from './paths.js';
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
}
