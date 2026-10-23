import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetDbForTests, type DB } from '../db.js';
import { getSession } from './sessions.js';
import { importHistory } from './importHistory.js';

/**
 * Backfilling history is what stops a fresh install opening on an empty
 * galaxy. These run against transcripts in Claude Code's real on-disk shape:
 * a session's own `*.jsonl` in the project directory, its subagents nested
 * beneath it.
 */
function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

function assistant(cost: {
  input: number;
  output: number;
  model?: string;
  ts: string;
}): string {
  return line({
    type: 'assistant',
    sessionId: 'ignored-after-first',
    timestamp: cost.ts,
    message: {
      model: cost.model ?? 'claude-sonnet-4-6',
      usage: { input_tokens: cost.input, output_tokens: cost.output },
    },
  });
}

describe('importHistory', () => {
  let db: DB;
  let base: string;

  beforeEach(() => {
    db = resetDbForTests();
    base = mkdtempSync(join(tmpdir(), 'solix-import-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** Write one session transcript in the real layout. */
  function writeSession(
    projectDir: string,
    sessionId: string,
    cwd: string,
    lines: string[],
  ): void {
    const dir = join(base, projectDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sessionId}.jsonl`),
      [
        line({ type: 'user', sessionId, cwd, timestamp: '2026-10-01T10:00:00.000Z' }),
        ...lines,
      ].join('\n'),
    );
  }

  it('imports a session with its real cost and dates', async () => {
    writeSession('-home-me-proj', 'sess-a', '/home/me/proj', [
      assistant({ input: 1_000_000, output: 100_000, ts: '2026-10-01T10:05:00.000Z' }),
    ]);

    const res = await importHistory(db, { base });

    expect(res.imported).toBe(1);
    expect(res.failed).toBe(0);
    const s = getSession(db, 'sess-a');
    expect(s).toBeTruthy();
    expect(s!.cwd).toBe('/home/me/proj');
    // Priced by the same costForUsage the live watcher uses: sonnet is
    // $3/M input, $15/M output → 3.00 + 1.50.
    expect(s!.costUsd).toBeCloseTo(4.5, 6);
    // Put back in time rather than claiming to have started now.
    expect(s!.createdAt).toBe(Date.parse('2026-10-01T10:00:00.000Z'));
    expect(s!.status).toBe('idle');
  });

  it('is safe to run twice', async () => {
    writeSession('-home-me-proj', 'sess-a', '/home/me/proj', [
      assistant({ input: 1000, output: 100, ts: '2026-10-01T10:05:00.000Z' }),
    ]);

    const first = await importHistory(db, { base });
    const second = await importHistory(db, { base });

    expect(first.imported).toBe(1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(1);
  });

  /**
   * A session Solix already knows is live, or already has cost for, must not
   * be overwritten by a re-import — that would reset a running session.
   */
  it('leaves a session Solix already has alone', async () => {
    writeSession('-home-me-proj', 'sess-live', '/home/me/proj', [
      assistant({ input: 1_000_000, output: 0, ts: '2026-10-01T10:05:00.000Z' }),
    ]);
    await importHistory(db, { base });
    const before = getSession(db, 'sess-live')!;

    // Pretend it is now running and has spent more.
    db.prepare(`UPDATE sessions SET status = 'active', cost_usd = 99 WHERE id = ?`).run(
      'sess-live',
    );
    await importHistory(db, { base });

    const after = getSession(db, 'sess-live')!;
    expect(after.status).toBe('active');
    expect(after.costUsd).toBe(99);
    expect(after.createdAt).toBe(before.createdAt);
  });

  /**
   * Subagent transcripts carry usage too. The live watcher reads only a
   * session's own file, so importing them as sessions would both invent
   * planets and count their spend a second time.
   */
  it('does not import subagent transcripts', async () => {
    writeSession('-home-me-proj', 'sess-a', '/home/me/proj', [
      assistant({ input: 1000, output: 100, ts: '2026-10-01T10:05:00.000Z' }),
    ]);
    const sub = join(base, '-home-me-proj', 'sess-a', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'agent-xyz.jsonl'),
      line({
        type: 'assistant',
        sessionId: 'agent-xyz',
        cwd: '/home/me/proj',
        timestamp: '2026-10-01T10:06:00.000Z',
        message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 500 } },
      }),
    );

    const res = await importHistory(db, { base });
    expect(res.imported).toBe(1);
    expect(getSession(db, 'agent-xyz')).toBeNull();
  });

  it('survives a half-written line without losing the session', async () => {
    const dir = join(base, '-home-me-proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'sess-trunc.jsonl'),
      [
        line({
          type: 'user',
          sessionId: 'sess-trunc',
          cwd: '/home/me/proj',
          timestamp: '2026-10-01T10:00:00.000Z',
        }),
        assistant({ input: 1000, output: 100, ts: '2026-10-01T10:01:00.000Z' }),
        '{"type":"assistant","mess', // still being written
      ].join('\n'),
    );

    const res = await importHistory(db, { base });
    expect(res.imported).toBe(1);
    expect(getSession(db, 'sess-trunc')).toBeTruthy();
  });

  it('counts a transcript with no session id as failed, not imported', async () => {
    const dir = join(base, '-home-me-proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'empty.jsonl'), line({ type: 'summary' }));

    const res = await importHistory(db, { base });
    expect(res.imported).toBe(0);
    expect(res.failed).toBe(1);
  });

  it('reports nothing to do when there is no transcript directory', async () => {
    const res = await importHistory(db, { base: join(base, 'does-not-exist') });
    expect(res).toMatchObject({ scanned: 0, imported: 0, failed: 0 });
  });

  it('groups sessions under their projects', async () => {
    writeSession('-home-me-a', 'sess-a', '/home/me/a', [
      assistant({ input: 1000, output: 0, ts: '2026-10-01T10:05:00.000Z' }),
    ]);
    writeSession('-home-me-b', 'sess-b', '/home/me/b', [
      assistant({ input: 1000, output: 0, ts: '2026-10-02T10:05:00.000Z' }),
    ]);

    const res = await importHistory(db, { base });
    expect(res.imported).toBe(2);
    expect(res.projects).toBe(2);
  });
});
