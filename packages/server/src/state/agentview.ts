import { existsSync, readFileSync, readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionStatus } from '@solix/shared';
import type { DB } from '../db.js';
import type { Broadcaster } from '../broadcaster.js';
import { ensureProject } from './projects.js';
import {
  getSession,
  setAgentViewFields,
  upsertSession,
} from './sessions.js';

/**
 * Sprint L — Agent View bridge.
 *
 * Anthropic's Agent View (Claude Code v2.1.139+) hosts background
 * sessions under a per-user supervisor daemon. State lives on disk:
 *   ~/.claude/daemon/roster.json    — list of live sessions
 *   ~/.claude/jobs/<id>/state.json  — per-session snapshot
 *
 * We watch both, parse the snapshots, and mirror each Agent View
 * session into Solix's session table as `origin: 'agentview'`. Solix
 * then renders them as planets like any other session. Read-only —
 * the supervisor owns lifecycle. We never write to these files.
 *
 * The schema of state.json isn't formally documented, so we parse
 * defensively and fall back gracefully on unknown fields.
 */

const ROSTER_PATH = join(homedir(), '.claude', 'daemon', 'roster.json');
const JOBS_DIR = join(homedir(), '.claude', 'jobs');

interface RosterEntry {
  id?: string;
  cwd?: string;
}

interface AgentViewStateFile {
  // The supervisor's state schema isn't documented; we read fields
  // best-effort. None of these are required — missing fields are
  // treated as undefined.
  id?: string;
  cwd?: string;
  state?: string; // working | needs_input | idle | completed | failed | stopped
  summary?: string;
  pr_url?: string;
  pr_check_status?: string;
  worktree_path?: string;
  name?: string;
  model?: string;
}

interface AgentViewBridgeOpts {
  db: DB;
  broadcaster: Broadcaster;
}

/**
 * A read that can say it failed.
 *
 * `readRoster` and `readJobIds` both returned `[]` on error, which made "the
 * roster says nothing is running" and "we could not read the roster"
 * indistinguishable — and the reap below treats the first as grounds to mark
 * every mirrored session `terminated`. `suggestions.ts` renders `terminated`
 * as **"Done"**, so a single failed `readdirSync` had Solix telling you a
 * running agent had finished, from the absence of a reading.
 */
type Read<T> = { ok: true; value: T } | { ok: false };

/** State strings the supervisor is known to write. */
const KNOWN_STATES = new Set([
  'working',
  'needs_input',
  'idle',
  'completed',
  'failed',
  'stopped',
]);

/** State strings we have already complained about, so we complain once each. */
const unknownStatesSeen = new Set<string>();

/** Jobs we have already reported as unreadable, likewise. */
const unreadableJobsSeen = new Set<string>();

/**
 * Say once that a job is being skipped.
 *
 * Silence here is the problem: a session whose `state.json` cannot be read
 * keeps rendering its last-seen status with full confidence, and is not
 * reaped either, because its directory still exists. One line in the log is
 * the difference between a stale frame and an invisible one.
 */
function noteUnreadable(jobId: string, why: string): void {
  if (unreadableJobsSeen.has(jobId)) return;
  unreadableJobsSeen.add(jobId);
  console.warn(
    `[solix] Agent View job ${jobId} skipped — ${why}. ` +
      'Its session keeps the last status Solix saw.',
  );
}

/**
 * Map Agent View state strings → Solix SessionStatus.
 *
 * An unrecognised state used to return `idle`, which is a **positive
 * assertion** about a session we know nothing about: a dormant planet, the
 * dimmest colour in the palette, second-from-last in the list sort. If the
 * supervisor ever renamed `needs_input`, a session blocked on a human would
 * quietly leave the attention path — "Needs you" and all.
 *
 * Fourteen lines below, `mapPrStatus` makes the opposite call on identically
 * undocumented data: unrecognised → `undefined` → the chip is simply absent,
 * claiming nothing. That is the right instinct, and this is it applied here.
 * "Parse defensively", in the docstring at the top of this file, means never
 * throw; it does not mean never assert.
 */
export function mapStatus(state: string | undefined): SessionStatus {
  switch (state) {
    case 'working':
      return 'active';
    case 'needs_input':
      return 'awaiting_input';
    case 'idle':
      return 'idle';
    case 'completed':
      return 'terminated';
    case 'failed':
      return 'error';
    case 'stopped':
      return 'terminated';
    default:
      if (state !== undefined && !KNOWN_STATES.has(state) && !unknownStatesSeen.has(state)) {
        unknownStatesSeen.add(state);
        console.warn(
          `[solix] Agent View reported a state Solix does not know: "${state}". ` +
            'Showing it as unknown rather than guessing.',
        );
      }
      return 'unknown';
  }
}

function mapPrStatus(
  s: string | undefined,
): 'pending' | 'success' | 'failure' | 'neutral' | undefined {
  if (!s) return undefined;
  if (s === 'pending' || s === 'success' || s === 'failure' || s === 'neutral')
    return s;
  return undefined;
}

function readRoster(rosterPath: string): Read<RosterEntry[]> {
  // A roster that is not there is a real answer — plenty of installs never
  // write one, which is why `liveIds` unions two sources. A roster that is
  // there and unreadable is not.
  if (!existsSync(rosterPath)) return { ok: true, value: [] };
  try {
    const raw = readFileSync(rosterPath, 'utf8');
    const parsed = JSON.parse(raw) as
      | { sessions?: RosterEntry[] }
      | RosterEntry[]
      | null;
    if (Array.isArray(parsed)) return { ok: true, value: parsed };
    if (parsed && Array.isArray(parsed.sessions)) {
      return { ok: true, value: parsed.sessions };
    }
    return { ok: true, value: [] };
  } catch {
    return { ok: false };
  }
}

function readJobIds(jobsDir: string): Read<string[]> {
  if (!existsSync(jobsDir)) return { ok: true, value: [] };
  try {
    return {
      ok: true,
      value: readdirSync(jobsDir).filter((entry) => {
        try {
          return statSync(join(jobsDir, entry)).isDirectory();
        } catch {
          return false;
        }
      }),
    };
  } catch {
    return { ok: false };
  }
}

function readJobState(jobsDir: string, jobId: string): AgentViewStateFile | null {
  const p = join(jobsDir, jobId, 'state.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as AgentViewStateFile;
  } catch {
    return null;
  }
}

/**
 * Sync the current on-disk Agent View state into the Solix DB. Called
 * on boot and on each fs.watch event (debounced). Idempotent —
 * sessions already present get their changed fields updated; new
 * sessions get inserted; sessions missing from the roster but
 * previously seen are marked terminated.
 */
export async function syncFromDisk({
  db,
  broadcaster,
  rosterPath = ROSTER_PATH,
  jobsDir = JOBS_DIR,
}: AgentViewBridgeOpts & {
  /** Overridable so a test can point them at a temp dir, or at a file to
   *  make the read genuinely fail. You cannot portably force an EACCES —
   *  CI often runs as root — but `readdirSync` on a file is ENOTDIR
   *  everywhere. */
  rosterPath?: string;
  jobsDir?: string;
}): Promise<void> {
  const roster = readRoster(rosterPath);
  const jobIds = readJobIds(jobsDir);
  // Union of ids known to disk. Some setups write state.json before
  // the roster updates, so we trust both sources.
  const liveIds = new Set<string>();
  if (roster.ok) for (const e of roster.value) if (e.id) liveIds.add(e.id);
  if (jobIds.ok) for (const id of jobIds.value) liveIds.add(id);

  let processed = 0;
  for (const agentViewId of liveIds) {
    // Yield to the event loop every 16 jobs so a large ~/.claude/jobs (a
    // heavy Agent View user can accumulate thousands) never blocks the HTTP
    // server from answering /api/health during the initial scan. Each job
    // does synchronous fs + DB work; without this the whole scan runs in one
    // uninterruptible burst.
    if ((processed++ & 15) === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    // Two ways to fall out of this loop without touching the row, and
    // neither used to leave a trace. The session keeps its last-seen status
    // and even its `updated_at`, so nothing downstream can tell a live
    // reading from a frozen one. A truncated mid-write `state.json` heals
    // on the next sync ~50ms later; a permanently malformed one, or one
    // with no `cwd`, does not.
    const state = readJobState(jobsDir, agentViewId);
    if (!state) {
      noteUnreadable(agentViewId, 'its state.json could not be read');
      continue;
    }
    const cwd = state.cwd ?? '';
    if (!cwd) {
      noteUnreadable(agentViewId, 'its state.json names no working directory');
      continue;
    }

    // Solix's session id for an Agent View session: prefixed so we
    // don't collide with hook-driven session ids (claude assigns
    // UUIDs to those).
    const solixId = `av-${agentViewId}`;
    const existing = getSession(db, solixId);
    const status = mapStatus(state.state);
    const summary = state.summary ?? null;
    const prUrl = state.pr_url ?? null;
    const prCheckStatus = mapPrStatus(state.pr_check_status) ?? null;

    if (!existing) {
      const project = ensureProject(db, cwd);
      const session = upsertSession(db, {
        id: solixId,
        pid: 0, // we don't know the pid; supervisor owns it
        projectId: project.id,
        cwd,
        origin: 'agentview',
        model: (state.model ?? 'default') as
          | 'opus'
          | 'sonnet'
          | 'haiku'
          | 'default',
        kind: 'user',
        worktreePath: state.worktree_path ?? undefined,
        agentViewId,
        agentViewSummary: summary ?? undefined,
        prUrl: prUrl ?? undefined,
        prCheckStatus: prCheckStatus ?? undefined,
      });
      // upsertSession initializes status to 'idle'; bring it to the
      // real Agent View status with a separate update.
      const updated = setAgentViewFields(db, solixId, { status });
      broadcaster.broadcast({
        type: 'session_upsert',
        session: updated ?? session,
      });
      continue;
    }

    // Existing: diff and only update changed fields.
    const changed =
      existing.status !== status ||
      (existing.agentViewSummary ?? null) !== summary ||
      (existing.prUrl ?? null) !== prUrl ||
      (existing.prCheckStatus ?? null) !== prCheckStatus;
    if (!changed) continue;
    const updated = setAgentViewFields(db, solixId, {
      status,
      agentViewSummary: summary,
      prUrl,
      prCheckStatus,
    });
    if (updated) broadcaster.broadcast({ type: 'session_upsert', session: updated });
  }

  // Reap: any session we've seen before with origin=agentview and not
  // in the current liveIds set transitions to terminated. We don't
  // delete — the user may still want to peek at the history.
  //
  // Only when we actually read both sources. An unreadable roster or jobs
  // directory used to be indistinguishable from an empty one, and this loop
  // treats empty as grounds to declare every mirrored agent finished —
  // which `suggestions.ts` renders as "Done". Marking a running agent done
  // because a directory read failed is an assertion from an absence of
  // evidence, and it is exactly the shape this codebase keeps producing.
  if (!roster.ok || !jobIds.ok) {
    console.warn(
      '[solix] could not read Agent View state' +
        `${roster.ok ? '' : ` (${rosterPath})`}${jobIds.ok ? '' : ` (${jobsDir})`}` +
        ' — leaving the mirrored sessions as they are rather than marking them finished.',
    );
    return;
  }

  const rows = db
    .prepare(
      `SELECT id, agent_view_id FROM sessions
       WHERE origin = 'agentview' AND status != 'terminated'`,
    )
    .all() as { id: string; agent_view_id: string | null }[];
  for (const r of rows) {
    if (r.agent_view_id && !liveIds.has(r.agent_view_id)) {
      const updated = setAgentViewFields(db, r.id, { status: 'terminated' });
      if (updated)
        broadcaster.broadcast({ type: 'session_upsert', session: updated });
    }
  }
}

/**
 * Debounce a function — coalesces rapid fs.watch bursts (the
 * supervisor may write roster + multiple state.json files in quick
 * succession). 50ms is long enough to absorb a burst, short enough
 * to feel real-time in the UI.
 */
function debounce(fn: () => void, ms: number): () => void {
  let h: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (h) clearTimeout(h);
    h = setTimeout(() => {
      h = null;
      fn();
    }, ms);
  };
}

/**
 * Start the Agent View bridge. Returns a stop function. Safe to call
 * even if Agent View isn't installed — we no-op in that case.
 */
export function startAgentViewBridge(
  opts: AgentViewBridgeOpts,
): () => void {
  const claudeRoot = join(homedir(), '.claude');
  if (!existsSync(claudeRoot)) return () => {/* no claude install */};

  const sync = async (): Promise<void> => {
    try {
      await syncFromDisk(opts);
    } catch (err) {
      console.warn('[agentview] sync failed:', (err as Error).message);
    }
  };
  const debounced = debounce(() => void sync(), 50);

  // Initial scan — kicked off without blocking boot. syncFromDisk yields to
  // the event loop as it walks ~/.claude/jobs (readdir + statSync + readFile
  // + DB upsert per job), so even a large jobs dir never stalls the freshly
  // bound HTTP port — the server answers /api/health immediately while the
  // scan proceeds and broadcasts sessions in as it finds them. The fs
  // watchers below are registered synchronously so no on-disk change is
  // missed while the first scan runs.
  void sync();

  const watchers: FSWatcher[] = [];
  // roster.json is the most important — watch its containing dir so
  // we react to its creation/recreation too.
  const daemonDir = join(homedir(), '.claude', 'daemon');
  if (existsSync(daemonDir)) {
    try {
      watchers.push(watch(daemonDir, { persistent: false }, debounced));
    } catch (err) {
      console.warn(
        '[agentview] could not watch daemon dir:',
        (err as Error).message,
      );
    }
  }
  if (existsSync(JOBS_DIR)) {
    try {
      // recursive=true so we get state.json updates without
      // re-mounting per-job watchers as they come and go.
      watchers.push(watch(JOBS_DIR, { recursive: true, persistent: false }, debounced));
    } catch (err) {
      // Some filesystems (e.g. older Linux) don't support recursive
      // watch. Fall back to a coarse poll every 3s.
      console.warn('[agentview] recursive watch unsupported; falling back to poll');
      const poll = setInterval(sync, 3000);
      return () => {
        clearInterval(poll);
        for (const w of watchers) {
          try {
            w.close();
          } catch {
            /* ignore */
          }
        }
      };
    }
  }

  return () => {
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        /* ignore */
      }
    }
  };
}
