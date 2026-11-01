import { serve } from "@hono/node-server";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Broadcaster } from "./broadcaster.js";
import { getDb, type DB } from "./db.js";
import { createHttpApp } from "./http.js";
import { Launcher } from "./launcher.js";
import { DB_PATH } from "./paths.js";
import { EventRouter } from "./router.js";
import { attachWs } from "./ws.js";
import {
  getAdvisor,
  listAdvisors,
  readAdvisorAgentMd,
  seedAdvisors,
} from "./state/advisors.js";
import { Orchestrator } from "./orchestrator/index.js";
import { LauncherSessionRunner } from "./orchestrator/launcher-runner.js";
import { discoverSkills } from "./state/skills.js";
import { TranscriptWatcherManager } from "./state/transcript.js";
import { cleanupOrphanedSockets } from "./state/wrappers.js";
import { startAgentViewBridge } from "./state/agentview.js";
import {
  listDueSchedules,
  markScheduleRun,
  recordScheduleRun,
} from "./state/schedules.js";
import type { ScheduledTask, TriggerKind } from "@solix/shared";
import { startNotificationDispatcher } from "./state/notifiers.js";
import { ensureDefaultOrg, getSetting, setSetting } from "./state/orgs.js";
import { now } from "./util.js";

// Models a plan task may be dispatched with (mirrors the New Task picker).
// Used to allowlist the planner's JSON output before it can reach a launch.
const KNOWN_MODELS = [
  "default",
  "opus",
  "sonnet",
  "haiku",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-haiku-4-5-20251001",
  "claude-fable-5-1",
];

export interface SolixServerOptions {
  port?: number;
  hostname?: string;
  /** Product version, surfaced at /api/health. The CLI passes its own
   * package version; defaults to "unknown" when embedded directly. */
  version?: string;
  /** Hook install state for /api/diagnostics. Only the CLI can answer this
   *  honestly, since it owns the install; omitted when embedded. */
  hookStatus?: () => {
    installed: boolean;
    upToDate: boolean;
    stampedVersion: string | null;
    claudeCodePresent: boolean;
    supported: boolean;
  };
}

export interface SolixServerHandle {
  port: number;
  hostname: string;
  close: () => Promise<void>;
}

/** Marks the historical-spend reset as done, so it happens exactly once. */
const COST_RESET_KEY = "cost_reset_double_count_v1";

/**
 * Zero every recorded figure once, because some of them are wrong and there
 * is no way to tell which.
 *
 * Until this release the transcript watcher re-counted its replay window on
 * every start, so a session's `cost_usd` and a mission's `total_tokens` grew
 * by the same messages each time Solix was restarted — measured at exactly
 * 2.00× on a two-message transcript, compounding. Any install that has been
 * restarted is carrying inflated numbers, and nothing in the database
 * distinguishes real spend from spend counted twice.
 *
 * So the figures are reset rather than adjusted. It is a deliberate trade:
 * it destroys genuine history, including figures that were never inflated,
 * in exchange for a number that is obviously starting over instead of
 * quietly wrong. `solix ledger` and `solix gain` lose their past spend with
 * it.
 *
 * It says so on stdout. A product whose front page is "watch the money"
 * should not zero your spend history in silence.
 */
/**
 * Copy the database beside itself, before anything destroys what is in it.
 *
 * Returns the path written, or null when there was nothing to copy, the copy
 * failed, or **the copy could not be shown to contain the data**. A failed
 * backup must not stop a server starting, but it must change what we claim,
 * which is why the caller prints the path it is given rather than one it
 * assumed.
 *
 * Two things this has to get right, and the first version got neither.
 *
 * `DB_PATH`, not `~/.solix`: `SOLIX_DB_PATH` is real — `solix demo` points
 * the whole server at a sandbox database — and a backup written to the wrong
 * directory is worse than none.
 *
 * And the checkpoint. This database runs in WAL mode (`db.ts`,
 * `journal_mode = WAL`), so recent transactions live in a `-wal` sidecar
 * until they are checkpointed. A plain `copyFileSync` of the `.db` therefore
 * produced a file of exactly the right name, in exactly the right place,
 * **missing the figures it was taken to preserve** — found by a test that
 * opened the copy instead of checking it existed. `wal_checkpoint(TRUNCATE)`
 * folds the sidecar in first, and then the copy is opened and read back,
 * because the whole value of this file is that someone can trust it later
 * without being able to check.
 */
function backupDbBeside(db: DB, label: string): string | null {
  const target = `${DB_PATH}.${label}.bak`;
  try {
    if (!existsSync(DB_PATH)) return null; // in-memory, or a fresh install
    db.pragma("wal_checkpoint(TRUNCATE)");
    copyFileSync(DB_PATH, target);

    // Read it back.
    //
    // Depth, not the mechanism: with the checkpoint above the copy is
    // complete, and removing this changes no test result — proven by
    // deleting it and watching all seven still pass. It stays because the
    // checkpoint can be refused when another connection holds the database
    // busy, and the failure mode then is a file of the right name in the
    // right place with the wrong contents inside it, which is strictly
    // worse than no file at all. That is the shape this whole fix exists to
    // avoid, so the cheap check that would catch it is worth keeping even
    // unproven.
    const copy = new Database(target, { readonly: true });
    try {
      const { n } = copy
        .prepare(`SELECT count(*) AS n FROM sessions WHERE cost_usd > 0`)
        .get() as { n: number };
      const { live } = db
        .prepare(`SELECT count(*) AS live FROM sessions WHERE cost_usd > 0`)
        .get() as { live: number };
      if (n !== live) throw new Error(`copy has ${n} of ${live} session(s)`);
    } finally {
      copy.close();
    }
    return target;
  } catch {
    // Do not leave a file that failed verification: someone finding it later
    // would reasonably assume it was good.
    try {
      if (existsSync(target)) rmSync(target);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function resetDoubleCountedSpend(db: DB): void {
  if (getSetting(db, COST_RESET_KEY) === "done") return;

  const sessions = db
    .prepare(`SELECT count(*) AS n FROM sessions WHERE cost_usd > 0`)
    .get() as { n: number };
  const missions = db
    .prepare(`SELECT count(*) AS n FROM missions WHERE total_tokens > 0`)
    .get() as { n: number };

  // Only the announcement and the copy are conditional. A fresh install has
  // no history to lose, so it should not meet a paragraph about a reset that
  // did not apply to it — but the writes below still run, because
  // `transcript_pos` can hold a position recorded while the counting was
  // wrong even on a session whose cost happens to be zero. An earlier
  // version of this returned early here and skipped that, which the existing
  // CLAIM-COST-COUNTED-ONCE suite caught.
  const hasHistory = sessions.n > 0 || missions.n > 0;

  // Say it, and make it recoverable, BEFORE doing it.
  //
  // This used to print after the UPDATEs had run. The docstring above was
  // already right that "a product whose front page is 'watch the money'
  // should not zero your spend history in silence" — but reporting a fait
  // accompli is not the same as disclosing. Twenty files away, `start`
  // discloses the hooks it is about to write and backs settings.json up
  // first, for a change `solix uninstall` can reverse. This one cannot be
  // reversed, and it had neither.
  const backup = hasHistory ? backupDbBeside(db, "pre-cost-reset") : null;
  if (hasHistory) {
    console.log(
      `[solix] about to reset spend on ${sessions.n} session(s) and tokens on\n` +
        `        ${missions.n} mission(s). Until this version a restart re-counted\n` +
        "        part of each transcript, so those figures are too high and there\n" +
        "        is no way to tell by how much. They start from zero and are\n" +
        "        counted once from here. This happens only once.\n" +
        (backup
          ? `        Your previous figures are kept at:\n        ${backup}`
          : "        NOTE: the database could not be copied first, so the old\n" +
            "        figures are not recoverable."),
    );
  }

  db.prepare(`UPDATE sessions SET cost_usd = 0 WHERE cost_usd > 0`).run();
  db.prepare(
    `UPDATE missions SET total_tokens = 0 WHERE total_tokens > 0`,
  ).run();
  // Start every session's counting from the beginning of its transcript, so
  // the figures rebuild from zero rather than from a position that was set
  // while the counting was wrong.
  db.prepare(`UPDATE sessions SET transcript_pos = NULL`).run();
  setSetting(db, COST_RESET_KEY, "done");
}

export async function createSolixServer(
  opts: SolixServerOptions = {},
): Promise<SolixServerHandle> {
  const port = opts.port ?? 4242;
  const hostname = opts.hostname ?? "127.0.0.1";

  const db = getDb();
  seedAdvisors(db);
  discoverSkills(db);
  ensureDefaultOrg(db); // P3 #10 — tenancy baseline
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
  resetDoubleCountedSpend(db);
  // Boot diagnostic — prints the resolved DB path + row counts so a user
  // reporting an empty UI can confirm in one line which DB the server opened
  // and whether it actually has data. Best-effort; never blocks startup.
  try {
    const advisorCount = (
      db.prepare("SELECT count(*) AS n FROM advisors").get() as { n: number }
    ).n;
    const sessionCount = (
      db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }
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
        .filter((a) => a.role !== "conductor")
        .map((a) => a.id),
    knownModels: KNOWN_MODELS,
    getMaestroPrompt: () => {
      const a = getAdvisor(db, "maestro");
      if (!a) return "";
      // Strip the YAML frontmatter → a clean planner system prompt.
      return readAdvisorAgentMd(a)
        .replace(/^---\n[\s\S]*?\n---\n/, "")
        .trim();
    },
  });

  // Shared secret written by `solix install`. When present, the server
  // requires it on the spoofable /events ingestion surface. Absent (e.g. an
  // older install that predates the token) → no enforcement, same as before.
  const tokenPath = join(
    process.env.SOLIX_HOME ?? join(homedir(), ".solix"),
    "token",
  );
  let token: string | null = null;
  try {
    token = readFileSync(tokenPath, "utf8").trim() || null;
  } catch {
    token = null;
  }

  // Fire a routine now: launch its prompt, record the run, advance (interval
  // only), and broadcast. Shared by the heartbeat timer and the manual/webhook
  // fire routes so every trigger path records identical run history.
  const fireScheduleNow = (
    schedule: ScheduledTask,
    trigger: TriggerKind,
  ): { ok: true } | { ok: false; error: string } => {
    if (!schedule.cwd) {
      recordScheduleRun(db, {
        scheduleId: schedule.id,
        trigger,
        status: "skipped",
        detail: "no working directory set",
      });
      return {
        ok: false,
        error:
          "this routine has no working directory, so there is nowhere to run it",
      };
    }
    try {
      // A routine fires unattended, so it launches as an autonomous session:
      // correlated via --session-id and governed by the containment denylist
      // (dangerous tool calls hard-denied, safe ones auto-allowed) rather than
      // queueing a permission prompt for a human who isn't watching.
      launcher.launch({
        cwd: schedule.cwd,
        initialPrompt: schedule.prompt,
        sessionRole: "routine",
      });
      recordScheduleRun(db, {
        scheduleId: schedule.id,
        trigger,
        status: "fired",
        detail: schedule.prompt.slice(0, 120),
      });
      const updated = markScheduleRun(db, schedule.id);
      if (updated) {
        broadcaster.broadcast({ type: "schedule_upsert", schedule: updated });
        broadcaster.broadcast({
          type: "toast",
          level: "info",
          message: `${trigger === "interval" ? "Heartbeat" : trigger === "webhook" ? "Webhook" : "Manual run"} fired: ${schedule.name ?? schedule.prompt.slice(0, 32)}`,
        });
      }
      return { ok: true };
    } catch (err) {
      recordScheduleRun(db, {
        scheduleId: schedule.id,
        trigger,
        status: "error",
        detail: (err as Error).message,
      });
      return { ok: false, error: (err as Error).message };
    }
  };

  const app = createHttpApp({
    db,
    router,
    orchestrator,
    token,
    version: opts.version,
    hookStatus: opts.hookStatus,
    fireSchedule: fireScheduleNow,
  });

  /**
   * Wait for the bind, and surface a failure instead of crashing.
   *
   * `serve()` returns synchronously and attaches no error handler, so
   * createSolixServer resolved whether or not the port was free. `start`
   * then printed "server listening on http://127.0.0.1:4242", opened a
   * browser at whatever was already there, and only then did EADDRINUSE
   * fire — as an unhandled 'error' event on the emitter, not a promise
   * rejection, so the top-level .catch in index.ts never saw it. The user
   * got a success message, someone else's server, and a raw Node stack
   * trace. `solix demo` has handled this since it shipped.
   */
  const server = await new Promise<ReturnType<typeof serve>>(
    (resolveServer, rejectServer) => {
      const s = serve({ fetch: app.fetch, port, hostname }, () => {
        resolveServer(s);
      });
      s.on("error", rejectServer);
    },
  );

  // Keep the handle: an open websocket is a socket the HTTP server will wait
  // for on close, and `closeAllConnections()` cannot help because Node stops
  // tracking a socket once it has been upgraded. Shutdown has to end these
  // itself — see `close()` below.
  const wss = attachWs(server as unknown as import("node:http").Server, {
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
    .catch((err) => console.error("[orchestrator] reconcile failed", err));

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
      for (const s of listDueSchedules(db, now())) {
        fireScheduleNow(s, "interval");
      }
    } catch (err) {
      console.warn("[scheduler] tick failed:", (err as Error).message);
    }
  }, 30_000);

  // P3 #11 — post fleet events (plan done/failed, escalations, budget) to any
  // configured Slack/Telegram notifiers by tapping the broadcaster.
  const stopNotifier = startNotificationDispatcher(db, broadcaster);

  return {
    port,
    hostname,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(scheduleTimer);
        stopNotifier();
        stopAgentViewBridge();
        transcripts.shutdownAll();
        launcher.shutdownAll();
        // Held permissions are open HTTP requests, and `server.close()` waits
        // for every one of them. Nothing can answer them now, so this used to
        // hang until the gate's own 300s timer fired: Ctrl+C did not quit, and
        // the agent sat blocked for five minutes. Record them, then drop the
        // sockets so each hook fails closed at once. See `abandonAllPending`.
        const abandoned = router.abandonAllPending(
          "Solix shut down while this was held",
        );
        if (abandoned > 0) {
          console.log(
            `[solix] ${abandoned} held request(s) refused on the way out`,
          );
        }
        // An open browser tab holds a websocket, and the HTTP server waits for
        // that socket too — so with the UI open (the state the brief puts you
        // in) Ctrl+C hung until you closed the tab. Measured: a client with a
        // 20s lifetime kept a signalled server alive 16.2s. `terminate()`
        // rather than `close()`, because a graceful handshake needs a peer
        // that is still listening, and we are going away now.
        for (const client of wss.clients) {
          try {
            client.terminate();
          } catch {
            /* already gone */
          }
        }
        wss.close();
        server.close(() => resolve());
        // Idle keep-alives are still tracked by the HTTP server, so these are
        // the ones `closeAllConnections` is for. Upgraded sockets are not —
        // Node drops them from its tracking — hence the loop above.
        (
          server as unknown as {
            closeAllConnections?: () => void;
          }
        ).closeAllConnections?.();
      }),
  };
}
