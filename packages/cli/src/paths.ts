import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOLIX_HOME = process.env.SOLIX_HOME ?? join(homedir(), '.solix');
export const HOOKS_DIR = join(SOLIX_HOME, 'hooks');
export const SOLIX_SKILLS_DIR = join(SOLIX_HOME, 'skills');
// Shared secret written at install time; hooks send it as X-Solix-Token and
// the server requires it on the /events ingestion surface.
export const SOLIX_TOKEN_FILE = join(SOLIX_HOME, 'token');
/**
 * Which Solix version last wrote the hook scripts.
 *
 * Without this, "are the hooks installed?" can only mean "do the files
 * exist?", and an upgrade that changes a hook script is never picked up —
 * every release after the first would run against the first release's hooks.
 */
export const SOLIX_INSTALL_STAMP = join(SOLIX_HOME, 'installed-version');
export const CLAUDE_DIR = join(homedir(), '.claude');
export const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json');
export const CLAUDE_BACKUP = join(CLAUDE_DIR, 'settings.solix.backup.json');
/**
 * The settings file as it was immediately before the most recent Solix write.
 *
 * CLAUDE_BACKUP is the pre-Solix original and `uninstall` restores from it,
 * so it must never be refreshed. That left upgrades — which re-run the
 * install and re-write settings.json — with no backup at all. This is that
 * backup, and it is overwritten every time, which is the point.
 */
export const CLAUDE_PREV_BACKUP = join(
  CLAUDE_DIR,
  'settings.solix.prev.json',
);
export const CLAUDE_AGENTS_DIR = join(CLAUDE_DIR, 'agents');
/**
 * The advisor files Solix has copied into `~/.claude/agents`.
 *
 * That directory is Claude Code's, not ours, and it may already hold agents
 * the user wrote. Without a record of which files are ours, `uninstall` can
 * only choose between leaving all of them behind (which it did) and deleting
 * agents it never installed. This is the record.
 */
export const SOLIX_AGENTS_MANIFEST = join(SOLIX_HOME, 'installed-agents.json');
export const CLAUDE_SKILLS_DIR = join(CLAUDE_DIR, 'skills');

export const HOOK_NAMES = [
  'session-start',
  'prompt-submit',
  'stop',
  'subagent-stop',
  'pre-tool-task',
  'pre-tool-file',
  'pre-tool-bash',
  'post-tool',
  'notification',
] as const;

export function packagedHooksDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Walk up looking for a hooks/ directory containing session-start.sh.
  // Handles: dist/hooks (built), packages/cli/hooks (dev/workspace).
  const candidates = [
    join(here, 'hooks'),
    join(here, '..', 'hooks'),
    join(here, '..', '..', 'hooks'),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, 'session-start.sh'))) return p;
  }
  return candidates[0]!;
}

export function packagedAgentsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'agents'),
    join(here, '..', '..', 'agents'),
    join(here, '..', '..', '..', 'agents'),
    join(here, '..', '..', '..', '..', 'packages', 'agents'),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, 'manifest.json'))) return p;
  }
  return candidates[0]!;
}

export function packagedSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'skills'),
    join(here, '..', '..', 'skills'),
    join(here, '..', '..', '..', 'skills'),
    join(here, '..', '..', '..', '..', 'packages', 'skills'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]!;
}
