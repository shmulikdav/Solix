import { beforeEach, describe, expect, it } from 'vitest';
import { resetDbForTests, type DB } from '../db.js';
import { loadTimeline } from './timeline.js';
import { ensureProject } from './projects.js';
import { upsertSession } from './sessions.js';

/**
 * The timeline drawer's scrubber, which had no test.
 *
 * Both queries were `ORDER BY started_at ASC LIMIT ?` — the **oldest** N —
 * and the final cap kept `events.slice(events.length - limit)`, the
 * **newest** of those. Two truncations in opposite directions compose into
 * something neither intended: in a window busier than the limit, the
 * genuinely recent events were never read out of SQLite at all.
 *
 * `latest` is then computed from what survived, so the drawer labels the
 * result "last 30 min" and puts the slider's right edge on a stale
 * timestamp. You scrub to the end of the playback and are looking at the
 * system as it was ten minutes ago, with nothing saying so.
 */
let db: DB;
const CWD = '/tmp/timeline-test';
const SID = 'tl-session';

function toolCalls(n: number, startMs: number, stepMs: number): void {
  const stmt = db.prepare(
    `INSERT INTO tool_calls (id, session_id, tool, status, started_at)
     VALUES (?, ?, ?, 'completed', ?)`,
  );
  for (let i = 0; i < n; i++) {
    stmt.run(`tc-${i}`, SID, i % 2 === 0 ? 'Bash' : 'Read', startMs + i * stepMs);
  }
}

beforeEach(() => {
  db = resetDbForTests();
  const project = ensureProject(db, CWD);
  upsertSession(db, {
    id: SID,
    pid: 1,
    projectId: project.id,
    cwd: CWD,
    origin: 'external',
  });
});

describe('loadTimeline', () => {
  /** Tool-call events only — the session's own creation is in here too. */
  const tools = (events: { toolName?: string }[]) =>
    events.filter((e) => e.toolName !== undefined);

  it('returns everything in a window it can hold', () => {
    const now = Date.now();
    toolCalls(10, now - 10_000, 100);
    const tr = loadTimeline(db, { sinceMs: now - 60_000, untilMs: now });
    expect(tools(tr.events)).toHaveLength(10);
    expect(tr.events[0]!.ts).toBeLessThanOrEqual(tr.events[tr.events.length - 1]!.ts);
  });

  it('keeps the most recent events when the window overflows', () => {
    // The defect. 500 calls, a limit of 50: the old code fetched the 50
    // OLDEST and then kept the newest of those — so `latest` landed near
    // the *start* of the window and the scrubber's right edge was 450
    // events in the past.
    const now = Date.now();
    const start = now - 500_000;
    toolCalls(500, start, 1_000);

    const tr = loadTimeline(db, { sinceMs: now - 600_000, untilMs: now, limit: 50 });

    const newestInDb = start + 499 * 1_000;
    const oldestInDb = start;
    expect(tr.events.length).toBeLessThanOrEqual(50);
    expect(
      tr.events.some((e) => e.ts === newestInDb),
      'the newest tool call in the window must be among the events fetched',
    ).toBe(true);
    expect(
      tr.events.some((e) => e.ts === oldestInDb),
      'and the oldest 50 are exactly what the old query returned instead',
    ).toBe(false);
    expect(
      tr.latest,
      'the scrubber ends at the end of the window, not where the fetch ran out',
    ).toBeGreaterThanOrEqual(newestInDb);
  });

  it('is still ordered oldest-first for playback', () => {
    // The query takes the newest N; playback needs them forwards.
    const now = Date.now();
    toolCalls(200, now - 200_000, 1_000);
    const tr = loadTimeline(db, { sinceMs: now - 300_000, untilMs: now, limit: 20 });
    for (let i = 1; i < tr.events.length; i++) {
      expect(tr.events[i]!.ts).toBeGreaterThanOrEqual(tr.events[i - 1]!.ts);
    }
    expect(tr.earliest).toBe(tr.events[0]!.ts);
  });

  it('reports the window itself when there is nothing in it', () => {
    // A fresh session is itself a timeline event, so this needs a window
    // that predates it rather than merely an empty table.
    const now = Date.now();
    const tr = loadTimeline(db, { sinceMs: now - 90_000, untilMs: now - 60_000 });
    expect(tr.events).toEqual([]);
    expect(tr.earliest).toBe(now - 90_000);
    expect(tr.latest).toBe(now - 60_000);
  });
});
