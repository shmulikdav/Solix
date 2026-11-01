import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerMessage } from '@solix/shared';
import { resetDbForTests, type DB } from '../db.js';
import { Broadcaster } from '../broadcaster.js';
import { mapStatus, syncFromDisk } from './agentview.js';
import { getSession, setAgentViewFields } from './sessions.js';

/**
 * CLAIM-AGENTVIEW-REPORTS-WHAT-IT-SEES.
 *
 * 328 lines mirroring `~/.claude/jobs` into Solix, with no test, and three
 * defects of one shape: asserting a fact from the absence of a reading.
 *
 * The file argues against itself. `mapPrStatus` degrades an unrecognised
 * value to `undefined` so the PR chip is simply absent — claiming nothing.
 * `mapStatus`, fourteen lines above, returned `idle` for the same class of
 * input: a positive claim (a dormant planet, the dimmest colour in the
 * palette, near the bottom of the sort) about a session nobody could read.
 *
 * The reap is the dangerous one. `readRoster` and `readJobIds` both returned
 * `[]` on failure, so "nothing is running" and "we could not look" were the
 * same value — and the reap marks every mirrored session `terminated` on the
 * first. `suggestions.ts` renders `terminated` as **"Done"**. A failed
 * `readdirSync` told the user a running agent had finished.
 *
 * The paths are parameters so this can be provoked deterministically. You
 * cannot portably force an EACCES — CI often runs as root — but `readdirSync`
 * on a *file* is ENOTDIR on every platform.
 */
let home: string;
let db: DB;
let sent: ServerMessage[];
let broadcaster: Broadcaster;
let jobsDir: string;
let rosterPath: string;

function job(id: string, state: Record<string, unknown>): void {
  mkdirSync(join(jobsDir, id), { recursive: true });
  writeFileSync(join(jobsDir, id, 'state.json'), JSON.stringify(state));
}

function roster(ids: string[]): void {
  mkdirSync(join(home, 'daemon'), { recursive: true });
  writeFileSync(rosterPath, JSON.stringify({ sessions: ids.map((id) => ({ id })) }));
}

const sync = () => syncFromDisk({ db, broadcaster, rosterPath, jobsDir });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'solix-av-'));
  jobsDir = join(home, 'jobs');
  rosterPath = join(home, 'daemon', 'roster.json');
  mkdirSync(jobsDir, { recursive: true });
  db = resetDbForTests();
  sent = [];
  broadcaster = new Broadcaster();
  broadcaster.broadcast = (m: ServerMessage): void => void sent.push(m);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe('CLAIM-AGENTVIEW-REPORTS-WHAT-IT-SEES · mapStatus', () => {
  it('maps the states the supervisor is known to write', () => {
    expect(mapStatus('working')).toBe('active');
    expect(mapStatus('needs_input')).toBe('awaiting_input');
    expect(mapStatus('idle')).toBe('idle');
    expect(mapStatus('completed')).toBe('terminated');
    expect(mapStatus('failed')).toBe('error');
    expect(mapStatus('stopped')).toBe('terminated');
  });

  it('says unknown for a state it does not recognise, rather than idle', () => {
    // The schema is undocumented. If the supervisor adds `queued`, or
    // renames `working`, the old mapping showed a running agent as a
    // dormant planet. Renaming `needs_input` was worse: a session blocked
    // on a human dropped out of the attention path entirely.
    for (const s of ['queued', 'running', 'paused', 'timed_out', '']) {
      expect(mapStatus(s), s).toBe('unknown');
    }
    expect(mapStatus(undefined)).toBe('unknown');
  });
});

describe('CLAIM-AGENTVIEW-REPORTS-WHAT-IT-SEES · mirroring', () => {
  it('creates a session from a job on disk', async () => {
    job('abc', { id: 'abc', cwd: '/tmp/work', state: 'working', summary: 'fixing the thing' });
    await sync();
    const s = getSession(db, 'av-abc')!;
    expect(s.status).toBe('active');
    expect(s.cwd).toBe('/tmp/work');
    expect(s.agentViewSummary).toBe('fixing the thing');
  });

  it('reaps a job that is genuinely gone', async () => {
    job('abc', { id: 'abc', cwd: '/tmp/work', state: 'working' });
    await sync();
    expect(getSession(db, 'av-abc')!.status).toBe('active');

    rmSync(join(jobsDir, 'abc'), { recursive: true });
    await sync();
    expect(getSession(db, 'av-abc')!.status).toBe('terminated');
  });

  it('records when it ended, so the timeline can show it', async () => {
    // setAgentViewFields never wrote terminated_at while setSessionStatus
    // did, and timeline.ts windows on that column — so no Agent View
    // session ending had ever appeared in the timeline.
    job('abc', { id: 'abc', cwd: '/tmp/work', state: 'working' });
    await sync();
    rmSync(join(jobsDir, 'abc'), { recursive: true });
    await sync();

    const row = db
      .prepare('SELECT terminated_at FROM sessions WHERE id = ?')
      .get('av-abc') as { terminated_at: number | null };
    expect(row.terminated_at).toBeTypeOf('number');
  });

  it('does not move the moment it ended if told twice', async () => {
    // Through `setAgentViewFields` directly, because the reap query already
    // excludes `terminated` rows and so can never call it twice. Written as
    // a sync-level test first, where it passed with the COALESCE removed —
    // it was asserting the reap's WHERE clause, not this function's
    // contract. The guard belongs to the writer, so it is tested there.
    job('twice', { id: 'twice', cwd: '/tmp/work', state: 'working' });
    await sync();

    const first = setAgentViewFields(db, 'av-twice', { status: 'terminated' });
    const firstTs = (
      db.prepare('SELECT terminated_at FROM sessions WHERE id = ?').get('av-twice') as {
        terminated_at: number;
      }
    ).terminated_at;
    expect(first?.status).toBe('terminated');
    expect(firstTs).toBeTypeOf('number');

    await new Promise((r) => setTimeout(r, 5));
    setAgentViewFields(db, 'av-twice', { status: 'terminated' });

    expect(
      (
        db.prepare('SELECT terminated_at FROM sessions WHERE id = ?').get('av-twice') as {
          terminated_at: number;
        }
      ).terminated_at,
      'a second sync must not rewrite when it ended',
    ).toBe(firstTs);
  });
});

describe('CLAIM-AGENTVIEW-REPORTS-WHAT-IT-SEES · a read it could not make', () => {
  it('does not declare every agent finished because the jobs dir was unreadable', async () => {
    // The one that matters. Previously: readdirSync throws, readJobIds
    // returns [], liveIds is empty, every mirrored session is marked
    // terminated and broadcast — and the UI says "Done".
    job('abc', { id: 'abc', cwd: '/tmp/work', state: 'working' });
    job('def', { id: 'def', cwd: '/tmp/other', state: 'needs_input' });
    await sync();
    expect(getSession(db, 'av-abc')!.status).toBe('active');
    expect(getSession(db, 'av-def')!.status).toBe('awaiting_input');

    // Replace the directory with a file: readdirSync → ENOTDIR, on every
    // platform and as any user. chmod 000 would not do it under root.
    rmSync(jobsDir, { recursive: true });
    writeFileSync(jobsDir, 'not a directory');

    sent = [];
    await sync();

    expect(getSession(db, 'av-abc')!.status).toBe('active');
    expect(getSession(db, 'av-def')!.status).toBe('awaiting_input');
    expect(sent, 'nothing should be broadcast from a failed read').toEqual([]);
  });

  it('does not declare them finished because the roster was corrupt', async () => {
    job('abc', { id: 'abc', cwd: '/tmp/work', state: 'working' });
    roster(['abc']);
    await sync();

    writeFileSync(rosterPath, '{ this is not json');
    await sync();

    expect(getSession(db, 'av-abc')!.status).toBe('active');
  });

  it('still reaps when the roster is simply absent, which is a real answer', async () => {
    // Plenty of installs never write a roster — that is why liveIds unions
    // two sources. "Not there" must stay distinguishable from "unreadable",
    // or the fix above would disable reaping altogether.
    job('abc', { id: 'abc', cwd: '/tmp/work', state: 'working' });
    await sync();
    rmSync(join(jobsDir, 'abc'), { recursive: true });

    await sync();

    expect(getSession(db, 'av-abc')!.status).toBe('terminated');
  });

  it('keeps the last status for a job whose state.json is malformed', async () => {
    job('abc', { id: 'abc', cwd: '/tmp/work', state: 'working' });
    await sync();

    writeFileSync(join(jobsDir, 'abc', 'state.json'), '{ truncated');
    await sync();

    // Not reaped — the directory is still there — and not silently idle.
    expect(getSession(db, 'av-abc')!.status).toBe('active');
  });

  it('says so, once, when it skips a job it cannot read', async () => {
    // A distinct id per test: the "complain once" set is module-level and
    // deliberately outlives a sync, so reusing `abc` here silently made
    // this assert nothing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    job('noisy-1', { id: 'noisy-1', cwd: '/tmp/work', state: 'working' });
    await sync();
    writeFileSync(join(jobsDir, 'noisy-1', 'state.json'), '{ truncated');

    await sync();
    await sync();

    const skips = warn.mock.calls.filter((c) => String(c[0]).includes('noisy-1'));
    expect(skips.length, 'once, not on every tick').toBe(1);
    expect(String(skips[0]![0])).toMatch(/keeps the last status/);
  });
});
