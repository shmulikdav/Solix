import { beforeEach, describe, expect, it } from 'vitest';
import type { HookEvent, ServerMessage, SessionRole } from '@solix/shared';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { ensureProject } from './state/projects.js';
import { upsertSession } from './state/sessions.js';
import { setGovernanceLevel, type GovernanceLevel } from './state/governance.js';
import { listAudit } from './state/audit.js';

/**
 * CLAIM-FLOOR-ALL-LEVELS · the whole decision surface, as a table.
 *
 * Three P0s have shipped in this gate, and not one of them was a logic
 * error anybody could see by reading the function. Each was a *cell nobody
 * had visited*:
 *
 *   - a non-default port, where the env never reached the hook;
 *   - a session with no role, where the floor returned early;
 *   - a session id with no row, where the floor sat behind the lookup.
 *
 * All three were found by running the product in a configuration that had
 * never been tried, and all three were covered by tests that passed
 * throughout. Individual tests pick the cells someone thought of. A table
 * makes the gaps visible, because an unvisited cell is a missing row rather
 * than an absence of thought.
 *
 * So this enumerates every combination of governance level, launch path and
 * command class, and states the expected decision for each. The table *is*
 * the specification: when the gate's behaviour is meant to change, this is
 * the file that says what it was.
 *
 * `sensitivity` is deliberately absent as a dimension. Nothing here filters
 * on how dangerous a command looks — what reaches the gate at all is decided
 * by which tools have a PreToolUse hook (Bash and file writes), and
 * everything that reaches it above `observe` is held. A `sensitive` axis here
 * would imply a filter that does not exist.
 *
 * The port dimension cannot be reached from this layer: it lives in the wire
 * between the hook and the server. `gate.contract.test.ts` and
 * `startPort.test.ts` hold that side.
 */

/** How a session got here. `newtask` has no role; `unknown` has no row. */
type LaunchPath = 'worker' | 'verifier' | 'routine' | 'newtask' | 'unknown';

/** `floor` must refuse regardless of the dial; `ordinary` is everything else. */
type CommandClass = 'floor' | 'ordinary';

/**
 * `blocked` — refused by containment, with a `command_blocked` row.
 * `allowed` — ran without anyone being asked.
 * `held`    — waiting for a human; the request is still open.
 */
type Outcome = 'blocked' | 'allowed' | 'held';

interface Cell {
  level: GovernanceLevel;
  path: LaunchPath;
  command: CommandClass;
  expect: Outcome;
  /** Set where this exact cell was a shipped defect. */
  wasP0?: string;
}

const COMMANDS: Record<CommandClass, string> = {
  floor: 'rm -rf /',
  ordinary: 'npm run build',
};

/**
 * The expected decision for all thirty cells, written out rather than
 * computed. A table derived from the same predicates it is testing would
 * agree with the bug.
 */
const MATRIX: Cell[] = [
  // ── observe ─ the dial is off; only the floor applies ──────────────────
  { level: 'observe', path: 'worker', command: 'floor', expect: 'blocked' },
  { level: 'observe', path: 'verifier', command: 'floor', expect: 'blocked' },
  { level: 'observe', path: 'routine', command: 'floor', expect: 'blocked' },
  {
    level: 'observe',
    path: 'newtask',
    command: 'floor',
    expect: 'blocked',
    wasP0:
      'the denylist returned early for anything without a sessionRole, so a ' +
      'New task ran `sudo -n true` unimpeded at observe — while the README ' +
      'and the level description both promised otherwise',
  },
  {
    level: 'observe',
    path: 'unknown',
    command: 'floor',
    expect: 'blocked',
    wasP0:
      'the floor was evaluated inside `if (session)`, so a tool call whose ' +
      'session row could not be found came back {"decision":"allow"}',
  },
  { level: 'observe', path: 'worker', command: 'ordinary', expect: 'allowed' },
  { level: 'observe', path: 'verifier', command: 'ordinary', expect: 'allowed' },
  { level: 'observe', path: 'routine', command: 'ordinary', expect: 'allowed' },
  { level: 'observe', path: 'newtask', command: 'ordinary', expect: 'allowed' },
  { level: 'observe', path: 'unknown', command: 'ordinary', expect: 'allowed' },

  // ── standard ─ the default. A human is watching a plan they approved ───
  { level: 'standard', path: 'worker', command: 'floor', expect: 'blocked' },
  { level: 'standard', path: 'verifier', command: 'floor', expect: 'blocked' },
  { level: 'standard', path: 'routine', command: 'floor', expect: 'blocked' },
  {
    level: 'standard',
    path: 'newtask',
    command: 'floor',
    expect: 'blocked',
    wasP0:
      'this was *held for a human* rather than refused — a different ' +
      'mechanism with a different promise, and it looked fine from the UI',
  },
  {
    level: 'standard',
    path: 'unknown',
    command: 'floor',
    expect: 'blocked',
    wasP0: 'also merely held, with no command_blocked row at any level',
  },
  { level: 'standard', path: 'worker', command: 'ordinary', expect: 'held' },
  { level: 'standard', path: 'verifier', command: 'ordinary', expect: 'held' },
  // A routine fires on a schedule with nobody at the keyboard. Holding one
  // would stall until the gate timed out and then deny, turning every
  // unattended run into a silent failure — so at standard it runs under the
  // denylist instead. `strict` is where that trade is refused.
  { level: 'standard', path: 'routine', command: 'ordinary', expect: 'allowed' },
  { level: 'standard', path: 'newtask', command: 'ordinary', expect: 'held' },
  { level: 'standard', path: 'unknown', command: 'ordinary', expect: 'held' },

  // ── strict ─ everything waits, including what fires unattended ─────────
  { level: 'strict', path: 'worker', command: 'floor', expect: 'blocked' },
  { level: 'strict', path: 'verifier', command: 'floor', expect: 'blocked' },
  { level: 'strict', path: 'routine', command: 'floor', expect: 'blocked' },
  { level: 'strict', path: 'newtask', command: 'floor', expect: 'blocked' },
  { level: 'strict', path: 'unknown', command: 'floor', expect: 'blocked' },
  { level: 'strict', path: 'worker', command: 'ordinary', expect: 'held' },
  { level: 'strict', path: 'verifier', command: 'ordinary', expect: 'held' },
  { level: 'strict', path: 'routine', command: 'ordinary', expect: 'held' },
  { level: 'strict', path: 'newtask', command: 'ordinary', expect: 'held' },
  { level: 'strict', path: 'unknown', command: 'ordinary', expect: 'held' },
];

const KNOWN_SESSION = 'matrix-session';
const ROLE_OF: Partial<Record<LaunchPath, SessionRole>> = {
  worker: 'worker',
  verifier: 'verifier',
  routine: 'routine',
  // `newtask` is deliberately absent: a task launched from the UI carries no
  // sessionRole, which is the hole the denylist used to fall through.
};

function bashEvent(sessionId: string, command: string): HookEvent {
  return {
    event: 'pre_tool_bash',
    pid: 4242,
    cwd: '/tmp/matrix',
    ts: Date.now(),
    payload: {
      session_id: sessionId,
      tool_name: 'Bash',
      tool_input: { command },
    },
  } as HookEvent;
}

describe('CLAIM-FLOOR-ALL-LEVELS · the gate decision matrix', () => {
  let db: DB;
  let router: EventRouter;

  beforeEach(() => {
    db = resetDbForTests();
    const broadcaster = new Broadcaster();
    // Swallow broadcasts; this test is about the decision, not the UI.
    broadcaster.broadcast = (_m: ServerMessage): void => {};
    router = new EventRouter(db, broadcaster);
    ensureProject(db, '/tmp/matrix');
  });

  /** Seed the session this cell describes, and return the id to send as. */
  function seed(path: LaunchPath): string {
    if (path === 'unknown') return 'no-such-session-id';
    const project = ensureProject(db, '/tmp/matrix');
    upsertSession(db, {
      id: KNOWN_SESSION,
      pid: 4242,
      projectId: project.id,
      cwd: '/tmp/matrix',
      origin: 'internal',
      sessionRole: ROLE_OF[path],
    });
    return KNOWN_SESSION;
  }

  /**
   * Ask, then classify. A held request never settles, so it is detected by
   * the router still holding it rather than by waiting for a timeout — which
   * keeps all thirty cells fast and, more importantly, deterministic.
   */
  async function decide(sessionId: string, command: string): Promise<Outcome> {
    const pending = router.requestPermission(bashEvent(sessionId, command));
    // Let the synchronous path settle.
    await new Promise((r) => setImmediate(r));
    if (router.pendingPermissions().length > 0) return 'held';
    const { approved } = await pending;
    if (approved) return 'allowed';
    const blocked = listAudit(db, { limit: 20 }).some(
      (r) => r.kind === 'command_blocked',
    );
    // A refusal with no containment row would be some other kind of denial,
    // and this matrix should not quietly call that "blocked".
    expect(blocked, 'refused, but with no command_blocked row').toBe(true);
    return 'blocked';
  }

  for (const cell of MATRIX) {
    const name =
      `${cell.level} · ${cell.path} · ${cell.command} → ${cell.expect}` +
      (cell.wasP0 ? '  [was a P0]' : '');
    it(name, async () => {
      setGovernanceLevel(db, cell.level);
      const sessionId = seed(cell.path);
      const outcome = await decide(sessionId, COMMANDS[cell.command]);
      expect(
        outcome,
        cell.wasP0
          ? `this cell shipped broken once: ${cell.wasP0}`
          : `expected ${cell.expect}`,
      ).toBe(cell.expect);
    });
  }

  it('covers every level × launch path × command class, with no gaps', () => {
    const levels: GovernanceLevel[] = ['observe', 'standard', 'strict'];
    const paths: LaunchPath[] = [
      'worker',
      'verifier',
      'routine',
      'newtask',
      'unknown',
    ];
    const classes: CommandClass[] = ['floor', 'ordinary'];
    const missing: string[] = [];
    for (const level of levels) {
      for (const path of paths) {
        for (const command of classes) {
          const found = MATRIX.some(
            (c) =>
              c.level === level && c.path === path && c.command === command,
          );
          if (!found) missing.push(`${level} · ${path} · ${command}`);
        }
      }
    }
    // The point of a table is that a hole is visible. This is the test that
    // makes adding a launch path or a level force you to fill it in.
    expect(missing, `unvisited cells:\n  ${missing.join('\n  ')}`).toEqual([]);
    expect(MATRIX).toHaveLength(levels.length * paths.length * classes.length);
  });

  it('the floor refuses at every level, which is the claim', () => {
    // Stated once, flatly, because this is the sentence the README and the
    // level descriptions make and it was false for three releases.
    const floorCells = MATRIX.filter((c) => c.command === 'floor');
    expect(floorCells).toHaveLength(15);
    expect(floorCells.every((c) => c.expect === 'blocked')).toBe(true);
  });
});
