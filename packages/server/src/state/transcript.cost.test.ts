import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from '../db.js';
import { resetDoubleCountedSpend } from '../create.js';
import { Broadcaster } from '../broadcaster.js';
import { TranscriptWatcherManager, transcriptPathFor } from './transcript.js';
import { ensureProject } from './projects.js';
import { getSession, setSessionMission, upsertSession } from './sessions.js';
import { startMission } from './missions.js';

/**
 * CLAIM-COST-COUNTED-ONCE · every figure is the transcript, summed once.
 *
 * `transcript.ts` is where every cost figure in the product comes from —
 * Mission Control's spend, the per-planet ring, `solix gain`, `solix ledger`,
 * and the budget that is supposed to pause a plan before it crosses a cap.
 * It had no test file of any kind, and it was double-charging.
 *
 * `emitAssistant` accumulates (`costUsd + inc`). `attach()` replays the tail
 * of an existing transcript, and for any file under the 64KB window that
 * means the whole thing. `records` lives in memory, so after a restart the
 * session's persisted `cost_usd` was still in the database and the replay
 * added the same messages on top of it. Measured before the fix: a
 * two-message transcript went from $0.1425 to $0.285 — exactly 2.00×, and
 * compounding with every restart. `addMissionTokens` sits in the same block
 * and doubled identically.
 *
 * The restart is not an edge case. It is the thing the 1.18.0 release notes
 * instruct people to do.
 *
 * The replay has two jobs and only one may repeat: chat deltas must be
 * re-emitted so the Chat tab has context, and sums must not. The fix is a
 * persisted high-water mark, which is why "the chat still replays" is a test
 * here — suppressing the replay would have fixed the money and broken the
 * panel the replay exists for.
 */
const CWD = '/tmp/solix-cost-test';
const SID = 'cost-test-session';

function assistantLine(inTok: number, outTok: number, id: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      id,
      content: [{ type: 'text', text: `reply ${id}` }],
      usage: { input_tokens: inTok, output_tokens: outTok },
    },
  })}\n`;
}

describe('CLAIM-COST-COUNTED-ONCE', () => {
  let db: DB;
  let file: string;
  let sent: ServerMessage[];

  /** A manager with its own broadcaster, so "a restart" is a fresh one. */
  function manager(): TranscriptWatcherManager {
    const b = new Broadcaster();
    b.broadcast = (m: ServerMessage): void => {
      sent.push(m);
    };
    return new TranscriptWatcherManager(db, b);
  }

  function costOf(): number {
    return getSession(db, SID)!.costUsd;
  }

  beforeEach(() => {
    db = resetDbForTests();
    sent = [];
    const project = ensureProject(db, CWD);
    upsertSession(db, {
      id: SID,
      pid: 1,
      projectId: project.id,
      cwd: CWD,
      origin: 'external',
    });
    file = transcriptPathFor(CWD, SID);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, assistantLine(1000, 500, 'a') + assistantLine(2000, 800, 'b'));
  });

  afterEach(() => {
    rmSync(dirname(file), { recursive: true, force: true });
  });

  it('a restart over an unchanged transcript does not charge again', () => {
    const m1 = manager();
    m1.startWatching(SID, CWD);
    const first = costOf();
    m1.shutdownAll();
    expect(first, 'nothing was counted at all').toBeGreaterThan(0);

    // The restart: a new process, the same database, the same file.
    const m2 = manager();
    m2.startWatching(SID, CWD);
    m2.shutdownAll();

    expect(
      costOf(),
      `spend changed with no new transcript content (${first} → ${costOf()}). ` +
        'This is the bug: budgets read this number, so a plan would pause ' +
        'before spend it never reached.',
    ).toBe(first);
  });

  it('and a third start does not either, since it compounded', () => {
    const m1 = manager();
    m1.startWatching(SID, CWD);
    const first = costOf();
    m1.shutdownAll();
    for (let i = 0; i < 2; i++) {
      const m = manager();
      m.startWatching(SID, CWD);
      m.shutdownAll();
    }
    expect(costOf()).toBe(first);
  });

  it('a session that keeps running still accrues', () => {
    // The fix must not be "stop counting".
    const m = manager();
    m.startWatching(SID, CWD);
    const before = costOf();

    appendFileSync(file, assistantLine(3000, 900, 'c'));
    m.readNow(SID);

    expect(costOf(), 'new work was not charged').toBeGreaterThan(before);
    m.shutdownAll();
  });

  it('counts lines written while Solix was down, exactly once', () => {
    // The reason for a persisted position rather than "skip the replay":
    // skipping would silently lose this, trading an inflated figure for a
    // missing one.
    const m1 = manager();
    m1.startWatching(SID, CWD);
    const before = costOf();
    m1.shutdownAll();

    appendFileSync(file, assistantLine(5000, 1000, 'offline'));

    const m2 = manager();
    m2.startWatching(SID, CWD);
    const after = costOf();
    m2.shutdownAll();
    expect(after, 'the offline message was not counted').toBeGreaterThan(before);

    // And not twice.
    const m3 = manager();
    m3.startWatching(SID, CWD);
    m3.shutdownAll();
    expect(costOf()).toBe(after);
  });

  it('mission tokens do not double either', () => {
    const mission = startMission(db, SID, 'counting tokens');
    setSessionMission(db, SID, mission.id);

    const m1 = manager();
    m1.startWatching(SID, CWD);
    const first = (
      db.prepare('SELECT total_tokens AS t FROM missions WHERE id = ?').get(mission.id) as
        | { t: number }
        | undefined
    )?.t;
    m1.shutdownAll();
    expect(first).toBeGreaterThan(0);

    const m2 = manager();
    m2.startWatching(SID, CWD);
    m2.shutdownAll();
    const second = (
      db.prepare('SELECT total_tokens AS t FROM missions WHERE id = ?').get(mission.id) as
        | { t: number }
        | undefined
    )?.t;
    expect(second, 'mission tokens doubled').toBe(first);
  });

  describe('the one-time reset of figures recorded while it was wrong', () => {
    it('zeroes spend and tokens, then never runs again', () => {
      const mission = startMission(db, SID, 'already counted twice');
      setSessionMission(db, SID, mission.id);
      // Figures as an existing install would carry them: inflated by some
      // unknowable amount, with no way to tell which part was real.
      db.prepare('UPDATE sessions SET cost_usd = 12.5 WHERE id = ?').run(SID);
      db.prepare('UPDATE missions SET total_tokens = 90000 WHERE id = ?').run(
        mission.id,
      );

      resetDoubleCountedSpend(db);
      expect(costOf()).toBe(0);
      expect(
        (
          db
            .prepare('SELECT total_tokens AS t FROM missions WHERE id = ?')
            .get(mission.id) as { t: number }
        ).t,
      ).toBe(0);

      // Real spend recorded after the upgrade must survive a second start.
      db.prepare('UPDATE sessions SET cost_usd = 3.25 WHERE id = ?').run(SID);
      resetDoubleCountedSpend(db);
      expect(
        costOf(),
        'the reset ran twice and ate spend that was counted correctly',
      ).toBe(3.25);
    });

    it('restarts counting from the beginning of each transcript', () => {
      // Otherwise a session keeps the position it reached while the counting
      // was wrong, and its figures would rebuild from a gap.
      db.prepare('UPDATE sessions SET transcript_pos = 4096 WHERE id = ?').run(
        SID,
      );
      resetDoubleCountedSpend(db);
      const row = db
        .prepare('SELECT transcript_pos AS p FROM sessions WHERE id = ?')
        .get(SID) as { p: number | null };
      expect(row.p).toBeNull();
    });
  });

  it('the chat still replays after a restart', () => {
    // The regression the obvious fix would have caused. The replay exists so
    // the Chat tab has recent context the moment it is opened; only the sums
    // must be suppressed.
    const m1 = manager();
    m1.startWatching(SID, CWD);
    m1.shutdownAll();

    sent = [];
    const m2 = manager();
    m2.startWatching(SID, CWD);
    m2.shutdownAll();

    const deltas = sent.filter((x) => x.type === 'chat_delta');
    expect(
      deltas.length,
      'the chat panel would open empty after a restart',
    ).toBeGreaterThan(0);
  });
});
