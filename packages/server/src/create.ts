import { serve } from '@hono/node-server';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Broadcaster } from './broadcaster.js';
import { getDb } from './db.js';
import { createHttpApp } from './http.js';
import { Launcher } from './launcher.js';
import { DB_PATH } from './paths.js';
import { EventRouter } from './router.js';
import { attachWs } from './ws.js';
import {
  getAdvisor,
  listAdvisors,
  readAdvisorAgentMd,
  seedAdvisors,
} from './state/advisors.js';
import { Orchestrator } from './orchestrator/index.js';
import { LauncherSessionRunner } from './orchestrator/launcher-runner.js';
import { discoverSkills } from './state/skills.js';
import { TranscriptWatcherManager } from './state/transcript.js';
import { cleanupOrphanedSockets } from './state/wrappers.js';
import { startAgentViewBridge } from './state/agentview.js';
import { listDueSchedules, markScheduleRun } from './state/schedules.js';
import { now } from './util.js';

// Models a plan task may be dispatched with (mirrors the New Task picker).
// Used to allowlist the planner's JSON output before it can reach a launch.
const KNOWN_MODELS = [
  'default',
  'opus',
  'sonnet',
  'haiku',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5-1',
];

export interface SolixServerOptions {
  port?: number;
  hostname?: string;
  /** Product version, surfaced at /api/health. The CLI passes its own
   * package version; defaults to "unknown" when embedded directly. */
  version?: string;
}

export interface SolixServerHandle {
  port: number;
  hostname: string;
  close: () => Promise<void>;
}

export async function createSolixServer(
  opts: SolixServerOptions = {},
): Promise<SolixServerHandle> {
  const port = opts.port ?? 4242;
  const hostname = opts.hostname ?? '127.0.0.1';

  const db = getDb();
  seedAdvisors(db);
  discoverSkills(db);
  // Stale `solix run` wrappers (from a previous server lifetime) leave
  // their .sock files behind. Clear them up front so the directory
  // doesn't grow unbounded across restarts. Also null any stored
  // wrapper_socket_path on sessions — wrappers don't survive a restart.
  const cleared = cleanupOrphanedSockets();
  if (cleared > 0) {
    console.log(`[solix] cleaned up ${cleared} orphaned wrapper socket(s)`);
  }
  db.prepare(
    `UPDATE sessions SET wrapper_socket_path = NULL WHERE wrapper_socket_path IS NOT NULL`,
  ).run();
  // Boot diagnostic — prints the resolved DB path + row counts so a user
  // reporting an empty UI can confirm in one line which DB the server opened
  // and whether it actually has data. Best-effort; never blocks startup.
  try {
    const advisorCount = (
      db.prepare('SELECT count(*) AS n FROM advisors').get() as { n: number }
    ).n;
    const sessionCount = (
      db.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }
    ).n;
    console.log(
      `[solix] db      -> ${DB_PATH} (advisors=${advisorCount}, sessions=${sessionCount})`,
    );
  } catch {
    /* counts are best-effort */
  }
  const broadcaster = new Broadcaster();
  const launcher = new Launcher(db, broadcaster);
  const transcripts = new TranscriptWatcherManager(db, broadcaster);
  const router = new EventRouter(db, broadcaster, launcher, transcripts);

  // v2 Maestro orchestrator: goal → plan → approve → dispatch → verify → report.
  const orchestrator = new Orchestrator({
    db,
    runner: new LauncherSessionRunner(launcher),
    broadcast: (msg) => broadcaster.broadcast(msg),
    getKnownAdvisorRoles: () =>
      listAdvisors(db)
        .filter((a) => a.role !== 'conductor')
        .map((a) => a.id),
    knownModels: KNOWN_MODELS,
    getMaestroPrompt: () => {
      const a = getAdvisor(db, 'maestro');
      if (!a) return '';
      // Strip the YAML frontmatter → a clean planner system prompt.
      return readAdvisorAgentMd(a)
        .replace(/^---\n[\s\S]*?\n---\n/, '')
        .trim();
    },
  });

  // Shared secret written by `solix install`. When present, the server
  // requires it on the spoofable /events ingestion surface. Absent (e.g. an
  // older install that predates the token) → no enforcement, same as before.
  const tokenPath = join(
    process.env.SOLIX_HOME ?? join(homedir(), '.solix'),
    'token',
  );
  let token: string | null = null;
  try {
    token = readFileSync(tokenPath, 'utf8').trim() || null;
  } catch {
    token = null;
  }

  const app = createHttpApp({
    db,
    router,
    orchestrator,
    token,
    version: opts.version,
  });

  const server = serve({
    fetch: app.fetch,
    port,
    hostname,
  });

  attachWs(server as unknown as import('node:http').Server, {
    db,
    router,
    broadcaster,
  });

  // Boot-time recovery: resume any plan left mid-run by a previous process,
  // re-dispatching tasks whose worker sessions died with it. Fire-and-forget so
  // startup isn't blocked; broadcasts reconcile connected clients. Never let the
  // detached promise reject unhandled.
  void orchestrator
    .reconcile()
    .catch((err) => console.error('[orchestrator] reconcile failed', err));

  // Sprint L: bridge to Anthropic's Agent View. Reads ~/.claude/daemon
  // + ~/.claude/jobs to mirror background sessions managed by the
  // claude-agents supervisor into Solix. No-op if Agent View isn't
  // installed locally.
  //
  // The demo sandbox (and any caller that sets SOLIX_DISABLE_AGENTVIEW) runs
  // isolated from the user's real Agent View state: it has its own seeded DB
  // and must not mirror external sessions into it. Skipping it also keeps a
  // heavy ~/.claude/jobs from being scanned inside the throwaway sandbox.
  const stopAgentViewBridge = process.env.SOLIX_DISABLE_AGENTVIEW
    ? (): void => {
        /* agent view bridge disabled for this process */
      }
    : startAgentViewBridge({ db, broadcaster });

  // Sprint M — heartbeat scheduler. Every ~30s, fire any enabled schedule
  // whose next_run_at has passed by launching it through the normal internal
  // launch path, then advance its next_run_at.
  const scheduleTimer = setInterval(() => {
    try {
      const due = listDueSchedules(db, now());
      for (const s of due) {
        if (!s.cwd) continue;
        launcher.launch({ cwd: s.cwd, initialPrompt: s.prompt });
        const updated = markScheduleRun(db, s.id);
        if (updated) {
          broadcaster.broadcast({ type: 'schedule_upsert', schedule: updated });
          broadcaster.broadcast({
            type: 'toast',
            level: 'info',
            message: `Heartbeat fired: ${s.name ?? s.prompt.slice(0, 32)}`,
          });
        }
      }
    } catch (err) {
      console.warn('[scheduler] tick failed:', (err as Error).message);
    }
  }, 30_000);

  return {
    port,
    hostname,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(scheduleTimer);
        stopAgentViewBridge();
        transcripts.shutdownAll();
        launcher.shutdownAll();
        server.close(() => resolve());
      }),
  };
}
