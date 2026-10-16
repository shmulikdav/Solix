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

export function ensureSolixHome(): void {
  mkdirSync(SOLIX_HOME, { recursive: true });
  mkdirSync(HOOKS_DIR, { recursive: true });
}
