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
 *   standard  sensitive calls from a task Solix launched are held. (default)
 *   strict    the orchestrator's own workers are held too, not auto-allowed.
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
      return 'observe — watching only; nothing is held for approval (the command denylist still blocks)';
    case 'strict':
      return 'strict — every tool call is held for you, including the orchestrator’s own workers';
    case 'standard':
    default:
      return 'standard — sensitive calls from tasks Solix launches are held for you';
  }
}

/**
 * Whether a tool call from a worker/verifier/routine should go to the human
 * gate rather than auto-allowing once it has passed containment.
 *
 * Only `strict` does this. At `standard` the denylist is the boundary for an
 * autonomous worker, not a prompt per step — a fleet that asks about every
 * file read is a fleet nobody runs.
 */
export function shouldGateContainedRole(level: GovernanceLevel): boolean {
  return level === 'strict';
}

/**
 * Whether the human gate is used at all. At `observe` a call that passed
 * containment proceeds without waiting for anyone.
 */
export function shouldGateAtAll(level: GovernanceLevel): boolean {
  return level !== 'observe';
}
