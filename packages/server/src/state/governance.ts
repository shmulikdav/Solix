import type { DB } from '../db.js';
import { getSetting, setSetting } from './orgs.js';

/**
 * How much Solix holds for you, as one dial.
 *
 * Governance was spread across three unrelated things: an env var that
 * silently switched containment off, a per-plan `autoMode` flag, and a human
 * gate that only ever applied to sessions without a contained role. Nothing
 * stated the resulting posture, so "how supervised am I right now" had no
 * answer — which is a poor property for the one feature the product is for.
 *
 * One dial, three levels, stated on startup and on change:
 *
 *   observe   watch only. No tool call is held for approval.
 *   standard  sensitive calls from a plan you are running are held. Routines,
 *             which fire with nobody watching, run under the denylist alone.
 *             (default)
 *   strict    routines are held too, rather than auto-allowed.
 *
 * **The denylist is not on this dial.** A command that would delete a home
 * directory or pipe the internet into a shell is refused at every level,
 * including `observe`. A dial that could turn that off would be a dial for
 * turning off the product's one guarantee; opting out of containment stays
 * where it was, an explicit environment variable, so it cannot be done by
 * accident from a menu.
 */
export type GovernanceLevel = 'observe' | 'standard' | 'strict';

const KEY = 'governance.level';
const DEFAULT: GovernanceLevel = 'standard';

const LEVELS: readonly GovernanceLevel[] = ['observe', 'standard', 'strict'];

export function isGovernanceLevel(v: unknown): v is GovernanceLevel {
  return typeof v === 'string' && (LEVELS as readonly string[]).includes(v);
}

export function getGovernanceLevel(db: DB): GovernanceLevel {
  const stored = getSetting(db, KEY);
  return isGovernanceLevel(stored) ? stored : DEFAULT;
}

export function setGovernanceLevel(db: DB, level: GovernanceLevel): GovernanceLevel {
  setSetting(db, KEY, level);
  return level;
}

/** One line, for startup and for `solix level`. */
export function describeGovernanceLevel(level: GovernanceLevel): string {
  switch (level) {
    case 'observe':
      return 'observe — watching only; nothing is held for approval (the command denylist still blocks what Solix launched)';
    case 'strict':
      return 'strict — sensitive calls are held for you, including from routines that fire unattended';
    case 'standard':
    default:
      return 'standard — sensitive calls from a plan you are running are held for you; routines run under the denylist';
  }
}

/** The roles that run under containment, and so reach this decision. */
export type ContainedRole = 'worker' | 'verifier' | 'routine';

/**
 * Whether a tool call from a contained role goes to the human gate rather
 * than auto-allowing once it has passed containment.
 *
 * This used to be `level === 'strict'`, which meant **nothing was ever held
 * at the default** — the human gate was unreachable, since contained roles
 * are the only sessions that carry the gate env at all. A Maestro worker
 * deleted a canary directory with `rm -rf` and nobody was asked, while the
 * line above still promised "sensitive calls from a task Solix launched are
 * held". The contract was right; the implementation never kept it.
 *
 * The split that matters is **whether a human is there**:
 *
 * - `worker` / `verifier` run from a plan someone just approved and is
 *   watching. Holding a risky command is the entire promise, and there is
 *   someone to answer it.
 * - `routine` fires on a schedule at 3am with nobody at the keyboard.
 *   Holding one would stall until the gate timed out and then fail closed,
 *   turning every unattended run into a silent failure. The denylist is the
 *   boundary there, as it always was.
 *
 * `strict` holds routines too, for someone who would rather a scheduled run
 * waited than proceeded unwatched.
 */
export function shouldGateContainedRole(
  level: GovernanceLevel,
  role: ContainedRole,
): boolean {
  if (level === 'observe') return false;
  if (level === 'strict') return true;
  return role !== 'routine';
}

/**
 * Whether the human gate is used at all. At `observe` a call that passed
 * containment proceeds without waiting for anyone.
 */
export function shouldGateAtAll(level: GovernanceLevel): boolean {
  return level !== 'observe';
}
