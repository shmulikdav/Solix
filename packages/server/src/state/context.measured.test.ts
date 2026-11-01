import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from '../db.js';
import { Broadcaster } from '../broadcaster.js';
import {
  TranscriptWatcherManager,
  contextPct,
  transcriptPathFor,
} from './transcript.js';
import { buildContextEnvelope } from './context.js';
import { ensureProject } from './projects.js';
import {
  getSession,
  setSessionContextUsage,
  upsertSession,
} from './sessions.js';
import { listAdvisors, seedAdvisors, setAdvisorEnabled } from './advisors.js';

/**
 * CLAIM-CONTEXT-IS-MEASURED · the context figure comes from the transcript.
 *
 * It did not. The watcher computed the percentage from an assistant message's
 * usage block and **broadcast it without writing it down**, so
 * `sessions.context_usage_pct` stayed at its `REAL DEFAULT 0` for the life of
 * every real install.
 *
 * The consequences all pointed the same way. Every advisor envelope said
 * `context=0%`. `contextBudgetNote`'s "⚠ CONTEXT NEAR LIMIT … run /compact"
 * branch was unreachable. The Advisor panel's preview chip read `target at
 * 0%`. The side panel disagreed with both, because the web store patches its
 * own copy from the websocket — and a browser reload dropped it back to zero.
 *
 * The only writer in the entire product was `solix demo`
 * (`packages/cli/src/demo.ts:702`, `:705`) with a hardcoded 62 and 89. **The
 * demo was the sole reason the number ever looked real**, which is the purest
 * form of the defect this ledger exists to catch.
 *
 * Making it nullable is part of the fix, not a flourish: once the watcher
 * persists, a stored `0` would be indistinguishable from "nothing has
 * measured this yet", and that ambiguity is what the old default created.
 */
const CWD = '/tmp/solix-context-test';
const SID = 'context-test-session';

function assistantLine(totalInput: number, id: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-opus-4-6',
      id,
      content: [{ type: 'text', text: `reply ${id}` }],
      usage: { input_tokens: totalInput, output_tokens: 10 },
    },
  })}\n`;
}

describe('CLAIM-CONTEXT-IS-MEASURED · contextPct', () => {
  it('is a straight proportion of the 200K anchor', () => {
    expect(contextPct(100_000)).toBeCloseTo(50);
    expect(contextPct(20_000)).toBeCloseTo(10);
    expect(contextPct(200_000)).toBeCloseTo(100);
  });

  it('says nothing rather than clamping a window it does not know', () => {
    // The old expression was `Math.min(100, (total / budget) * 100)`. A
    // session on a 1M window at 300K tokens reported a confident 100%,
    // `.toFixed(0)` hid that it had been clamped, and the advisor was told to
    // suggest /compact on a session that was 30% full. Exceeding the anchor
    // is evidence the anchor is wrong, not evidence the session is full.
    expect(contextPct(200_001)).toBeNull();
    expect(contextPct(1_000_000)).toBeNull();
  });

  it('has no reading for a message that reported no tokens', () => {
    expect(contextPct(0)).toBeNull();
    expect(contextPct(-1)).toBeNull();
    expect(contextPct(Number.NaN)).toBeNull();
  });
});

describe('CLAIM-CONTEXT-IS-MEASURED · the watcher writes it down', () => {
  let db: DB;
  let file: string;
  let sent: ServerMessage[];

  function manager(): TranscriptWatcherManager {
    const b = new Broadcaster();
    b.broadcast = (m: ServerMessage): void => {
      sent.push(m);
    };
    return new TranscriptWatcherManager(db, b);
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
  });

  afterEach(() => {
    rmSync(dirname(file), { recursive: true, force: true });
  });

  it('a fresh session has no reading at all, rather than 0%', () => {
    expect(getSession(db, SID)!.contextUsagePct).toBeNull();
  });

  it('persists the percentage, not just broadcasts it', () => {
    // The whole defect in one assertion.
    writeFileSync(file, assistantLine(100_000, 'a'));
    const m = manager();
    m.startWatching(SID, CWD);
    m.shutdownAll();

    expect(getSession(db, SID)!.contextUsagePct).toBeCloseTo(50);
    expect(
      sent.some((x) => x.type === 'context_update'),
      'the broadcast is still sent — the live panels depend on it',
    ).toBe(true);
  });

  it('survives a restart, which is what a browser reload reads', () => {
    // Before the fix, the live figure existed only in the browser's memory:
    // reloading the tab rehydrated from the database and showed 0% until the
    // agent happened to answer again.
    writeFileSync(file, assistantLine(100_000, 'a'));
    const m1 = manager();
    m1.startWatching(SID, CWD);
    m1.shutdownAll();

    const m2 = manager();
    m2.startWatching(SID, CWD);
    m2.shutdownAll();

    expect(getSession(db, SID)!.contextUsagePct).toBeCloseTo(50);
  });

  it('reports the latest message, not the sum of them', () => {
    // Context is a view of the newest message, which is why it sits outside
    // the counted-once guard that cost obeys. Summing these would read 75%.
    writeFileSync(file, assistantLine(100_000, 'a') + assistantLine(50_000, 'b'));
    const m = manager();
    m.startWatching(SID, CWD);
    m.shutdownAll();

    expect(getSession(db, SID)!.contextUsagePct).toBeCloseTo(25);
  });
});

describe('CLAIM-CONTEXT-IS-MEASURED · what the advisor is told', () => {
  let db: DB;

  let advisorId: string;

  function envelope(pct: number | null): string {
    setSessionContextUsage(db, SID, pct);
    const env = buildContextEnvelope(db, {
      advisorId,
      targetSessionId: SID,
      userPrompt: 'look at this',
    });
    if (!env) throw new Error('no envelope — the advisor was not found');
    return env.prompt;
  }

  beforeEach(() => {
    db = resetDbForTests();
    seedAdvisors(db); // the real roster — forge, lumen, argus, …
    const advisor = listAdvisors(db)[0]!;
    advisorId = advisor.id;
    setAdvisorEnabled(db, advisorId, true);
    const project = ensureProject(db, CWD);
    upsertSession(db, {
      id: SID,
      pid: 1,
      projectId: project.id,
      cwd: CWD,
      origin: 'external',
    });
  });

  it('says unknown when nothing has measured it', () => {
    // Not "0%". A model reasoning from `context=0%` believes it has the whole
    // window to play with, which is a claim nobody made.
    const text = envelope(null);
    expect(text).toContain('context=unknown');
    expect(text).not.toContain('context=0%');
  });

  it('says the measured figure when there is one', () => {
    expect(envelope(62)).toContain('context=62%');
  });

  it('warns about a nearly-full window — the branch that never fired', () => {
    const text = envelope(93);
    expect(text).toMatch(/CONTEXT NEAR LIMIT/);
    expect(text).toMatch(/\/compact/);
  });

  it('gives the softer warning in the middle band', () => {
    const text = envelope(84);
    expect(text).toMatch(/Context budget warning/);
    expect(text).not.toMatch(/CONTEXT NEAR LIMIT/);
  });

  it('warns about nothing when there is no measurement', () => {
    const text = envelope(null);
    expect(text).not.toMatch(/CONTEXT NEAR LIMIT/);
    expect(text).not.toMatch(/Context budget warning/);
  });
});
