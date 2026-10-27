import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const SOLIX_HOME =
  process.env.SOLIX_HOME ?? join(homedir(), '.solix');

// SOLIX_DB_PATH lets a caller (e.g. `solix demo`) point the server at an
// isolated SQLite file without disturbing the real ~/.solix/solix.db. Falls
// back to the canonical location when unset — backwards-compatible with every
// existing install.
export const DB_PATH =
  process.env.SOLIX_DB_PATH ?? join(SOLIX_HOME, 'solix.db');
export const HOOKS_DIR = join(SOLIX_HOME, 'hooks');
export const LOG_PATH = join(SOLIX_HOME, 'solix.log');
// User-authored skills (P3 #9) live here so they survive restarts and are
// discovered as source 'user' alongside the bundled anthropic/solix skills.
// Resolved lazily (reads env at call time) so tests can isolate it per-run.
export function userSkillsDir(): string {
  return process.env.SOLIX_USER_SKILLS_DIR ?? join(SOLIX_HOME, 'skills');
}

/**
 * Expand a leading `~` to the home directory.
 *
 * A person typing a project path writes `~/solix-qa`, because that is what
 * works everywhere else. Nothing expanded it, so the literal string reached
 * `spawn({ cwd })` — and Node reports a missing cwd as
 * `spawn claude ENOENT`, naming the COMMAND rather than the directory. The
 * failure therefore looked like a broken Claude Code install, which is the
 * worst possible place for it to point.
 *
 * Only a leading `~/` (or a bare `~`) is expanded. `~user` is left alone: it
 * means another user's home, which we cannot resolve correctly, and guessing
 * `<home>/../user` would be worse than not touching it.
 */
export function expandHome(p: string): string {
  const trimmed = p.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function ensureSolixHome(): void {
  mkdirSync(SOLIX_HOME, { recursive: true });
  mkdirSync(HOOKS_DIR, { recursive: true });
}
