import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { costForUsage, totalTokens, type TokenUsage } from '@solix/shared';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOLIX_HOME = process.env.SOLIX_HOME ?? join(homedir(), '.solix');
const DEMO_DB_PATH = join(SOLIX_HOME, 'demo.db');
const DEMO_PID_PATH = join(SOLIX_HOME, 'demo.pid');
const TOKEN_PATH = join(SOLIX_HOME, 'token');

// How long to wait for the freshly-spawned sandbox server to answer
// /api/health. A cold first run (right after `npm i -g`) loads the native
// better-sqlite3 addon, seeds 15 advisors from disk, and scans skills — all
// synchronously before the HTTP port binds — so 8s was too tight and killed
// servers that were about to be fine. 30s absorbs a cold boot comfortably;
// a healthy server answers on the first poll (~150ms) regardless.
const SERVER_BOOT_TIMEOUT_MS = 30_000;

// The sandbox server enforces the same x-solix-token gate on /events that a
// real install does (it reads ~/.solix/token via SOLIX_HOME, which the demo
// does NOT override). Read that token here so our seed POSTs authenticate.
// Empty when no install has run (dev) — the server then has no token
// configured either, so the header is simply omitted and nothing enforces.
let demoToken = '';
try {
  demoToken = readFileSync(TOKEN_PATH, 'utf8').trim();
} catch {
  /* no token configured */
}

// Ticker cadences — tuned to look alive without spamming the broadcaster on
// integrated graphics. All times in ms.
const TICKER_COMET_MS = 2500;       // tool-call comets
const TICKER_PROMOTE_MS = 25_000;   // idle↔active flips (ring transitions)
const TICKER_MISSION_MS = 45_000;   // complete + start a mission
const TICKER_PERMISSION_MS = 75_000; // new awaiting_permission flare
const TICKER_ADVISOR_MS = 120_000;  // advisor invoke (toast + audit row)

interface DemoOptions {
  port?: number;
  cwd?: string;
  keep?: boolean;
  noServer?: boolean;
  noTicker?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function ts(): number {
  return Date.now();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function isPortFree(port: number): Promise<boolean> {
  try {
    await fetch(`${baseUrl(port)}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    return false;
  } catch {
    return true;
  }
}

async function waitForServer(port: number, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!(await isPortFree(port))) return true;
    await sleep(150);
  }
  return false;
}

async function postEvent(base: string, payload: object): Promise<void> {
  try {
    await fetch(`${base}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(demoToken ? { 'x-solix-token': demoToken } : {}),
      },
      body: JSON.stringify(payload),
    });
  } catch {
    /* server may have gone away; ticker tolerates this silently */
  }
}

async function postJson<T = unknown>(
  base: string,
  path: string,
  body?: object,
): Promise<T | null> {
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) return null;
    if (res.headers.get('content-type')?.includes('json')) {
      return (await res.json()) as T;
    }
    return null;
  } catch {
    return null;
  }
}

async function getJson<T>(base: string, path: string): Promise<T | null> {
  try {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function randomChoice<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// ---------------------------------------------------------------------------
// Phase A — boot a sandbox server (if --no-server wasn't passed)
// ---------------------------------------------------------------------------

interface BootResult {
  child: ChildProcess | null;
  port: number;
  base: string;
}

/**
 * Kill a child process reliably: SIGTERM for a graceful shutdown, then SIGKILL
 * if it hasn't exited within a short grace period. A demo child whose event
 * loop is busy (e.g. mid-boot) can ignore SIGTERM long enough to become an
 * orphan that squats on the port and the sandbox DB — which is what made
 * repeated `solix demo` runs get "stuck". Escalating to SIGKILL prevents that.
 */
async function killChildHard(child: ChildProcess): Promise<void> {
  if (child.exitCode != null || child.signalCode != null) return; // already dead
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 20; i++) {
    if (child.exitCode != null || child.signalCode != null) return;
    await sleep(100); // up to ~2s for a graceful exit
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

/**
 * Reap any demo sandbox servers left behind by previous runs. Each spawned
 * child's PID is recorded in DEMO_PID_PATH (one per line); a crashed or
 * force-killed orchestrator can't clean up its child, so on the next run we
 * SIGTERM then SIGKILL every recorded PID that's still alive. Without this,
 * orphaned servers accumulate and hold the port + sandbox DB, and every later
 * `solix demo` fails to start.
 */
async function reapStaleDemoServers(): Promise<void> {
  if (!existsSync(DEMO_PID_PATH)) return;
  let pids: number[] = [];
  try {
    pids = readFileSync(DEMO_PID_PATH, 'utf8')
      .split('\n')
      .map((l) => parseInt(l.trim(), 10))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    pids = [];
  }
  const alive = pids.filter((pid) => {
    try {
      process.kill(pid, 0); // signal 0 just probes; throws if not running
      return true;
    } catch {
      return false;
    }
  });
  if (alive.length === 0) {
    try {
      unlinkSync(DEMO_PID_PATH);
    } catch {
      /* ignore */
    }
    return;
  }
  console.log(
    `[solix demo] cleaning up ${alive.length} stale sandbox server(s) from a previous run…`,
  );
  for (const pid of alive) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* ignore */
    }
  }
  await sleep(400);
  for (const pid of alive) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL'); // still alive → force it
    } catch {
      /* gone */
    }
  }
  try {
    unlinkSync(DEMO_PID_PATH);
  } catch {
    /* ignore */
  }
}

async function bootSandbox(preferredPort: number): Promise<BootResult | null> {
  // If someone is already listening on the preferred port AND it's our own
  // sandbox DB, reuse it. We can't introspect their DB path remotely, so we
  // pick a different port instead — simpler and avoids the demo writing into a
  // user-launched real server.
  let port = preferredPort;
  if (!(await isPortFree(port))) {
    console.log(
      `[solix demo] port ${port} is in use — falling back to ${port + 1} for the sandbox.`,
    );
    port += 1;
    if (!(await isPortFree(port))) {
      console.error(
        `[solix demo] both ${preferredPort} and ${port} are in use. Stop one of them or pass --port.`,
      );
      return null;
    }
  }

  // Reap every stale demo server left by previous runs (not just the last
  // one) before we spawn a fresh one.
  await reapStaleDemoServers();

  mkdirSync(SOLIX_HOME, { recursive: true });

  // Spawn ourselves with the `start` subcommand. import.meta.url points at
  // packages/cli/dist/index.js after build, which is also the binary the user
  // ran — same code path either way.
  const selfScript = fileURLToPath(import.meta.url);
  const child = spawn(
    process.execPath,
    [selfScript, 'start', '--port', String(port), '--no-open'],
    {
      env: {
        ...process.env,
        SOLIX_DB_PATH: DEMO_DB_PATH,
        // The demo is an isolated, seeded sandbox — it must not mirror the
        // user's real Agent View sessions into it, and scanning a heavy
        // ~/.claude/jobs at boot would stall the sandbox before it's ready.
        SOLIX_DISABLE_AGENTVIEW: '1',
      },
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: false,
    },
  );

  // Record the spawned PID so a stale demo from a crashed orchestrator can be
  // reaped on the next run (reapStaleDemoServers just cleared the file).
  if (child.pid) {
    try {
      writeFileSync(DEMO_PID_PATH, `${child.pid}\n`);
    } catch {
      /* ignore */
    }
  }

  child.on('exit', (code) => {
    if (code != null && code !== 0) {
      console.error(`[solix demo] sandbox server exited with code ${code}`);
    }
  });

  if (!(await waitForServer(port, SERVER_BOOT_TIMEOUT_MS))) {
    const secs = Math.round(SERVER_BOOT_TIMEOUT_MS / 1000);
    if (child.exitCode != null || child.signalCode != null) {
      console.error(
        `[solix demo] the sandbox server exited during startup (see the error above).`,
      );
    } else {
      console.error(
        `[solix demo] the sandbox server started but isn't responding on ${baseUrl(
          port,
        )} after ${secs}s.`,
      );
      console.error(
        `[solix demo] this usually means a firewall or security tool is blocking localhost, or a stale server is stuck. Try a fresh --port, or check that ${baseUrl(
          port,
        )} opens in your browser.`,
      );
    }
    await killChildHard(child);
    return null;
  }

  return { child, port, base: baseUrl(port) };
}

// ---------------------------------------------------------------------------
// Phase B — saturated seed
// ---------------------------------------------------------------------------

interface SeededSession {
  id: string;
  pid: number;
  cwd: string;
  projectName: string;
  model: string;
  status:
    | 'active'
    | 'idle'
    | 'awaiting_permission'
    | 'awaiting_input'
    | 'error'
    | 'plan_review';
}

interface SeedState {
  sessions: SeededSession[];
  advisorIds: string[];
}

const PROJECTS = [
  'web-app',
  'infrastructure',
  'data-pipeline',
  'mobile-client',
  'design-system',
  'observability',
  'ml-research',
  'docs-site',
] as const;

const MODELS = ['opus', 'sonnet', 'haiku', 'default'] as const;

const PROMPTS = [
  'Refactor the orbital math for stable layout',
  'Wire up the asteroid belt to real skill data',
  'Document the context envelope strategy',
  'Audit the auth flow for token leak risk',
  'Generate a migration plan for the new schema',
  'Triage the failing Playwright spec',
  'Build a flame graph from the last week of traces',
  'Sweep deprecated APIs out of the SDK',
  'Polish the README with three quickstart examples',
  'Draft a runbook for the budget breach scenario',
];

const TOOL_FILES = [
  'packages/web/src/scene/Planet.tsx',
  'packages/server/src/router.ts',
  'packages/cli/src/install.ts',
  'packages/shared/src/types.ts',
  'packages/web/src/store/index.ts',
];

const TOOL_COMMANDS = [
  'pnpm -r typecheck',
  'pnpm --filter @solix/web build',
  'git status -sb',
  'cargo test --workspace',
  'curl -s http://127.0.0.1:4242/api/health',
];

// Status distribution — hits every branch so the orbit-compression visuals
// pop, the Decision Queue surfaces a card, and the Audit / Mission views
// have something to show.
const STATUS_PLAN: SeededSession['status'][] = [
  ...Array<'active'>(5).fill('active'),
  ...Array<'awaiting_permission'>(3).fill('awaiting_permission'),
  ...Array<'awaiting_input'>(2).fill('awaiting_input'),
  ...Array<'error'>(1).fill('error'),
  ...Array<'plan_review'>(1).fill('plan_review'),
  ...Array<'idle'>(18).fill('idle'),
];

/**
 * Plausible token usage for a seeded session.
 *
 * Shaped like a real Claude Code session rather than a round number: most
 * input arrives as cache reads, output is a fraction of input, and a session
 * still working has done more of both. The dollar figure is then derived
 * through the same `costForUsage` the transcript watcher uses, so what the
 * demo shows is what those tokens would actually cost at list price — not an
 * invented number that happens to look plausible.
 *
 * Derived from the session id rather than `Math.random`, so a reseed of the
 * same galaxy produces the same spend and screenshots stay reproducible.
 */
function usageForSession(s: SeededSession): TokenUsage {
  const n = [...s.id].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const weight = s.status === 'active' ? 1.8 : s.status === 'idle' ? 1 : 1.3;
  const turns = 6 + (n % 19); // 6–24 assistant turns
  return {
    input_tokens: Math.round(turns * (900 + (n % 700)) * weight),
    cache_read_input_tokens: Math.round(turns * (7_000 + (n % 5_000)) * weight),
    cache_creation_input_tokens: Math.round(turns * (300 + (n % 400)) * weight),
    output_tokens: Math.round(turns * (450 + (n % 600)) * weight),
  };
}

async function richSeed(base: string, demoRootCwd: string): Promise<SeedState> {
  console.log(`[solix demo] seeding ${STATUS_PLAN.length} sessions across ${PROJECTS.length} projects…`);

  // 1) Enable every advisor so the Crew roster shows the full lineup.
  interface AdvisorRow {
    id: string;
    codename: string;
  }
  const advisors =
    (await getJson<AdvisorRow[]>(base, '/api/advisors')) ?? [];
  for (const a of advisors) {
    await postJson(base, `/api/advisors/${encodeURIComponent(a.id)}/enable`);
  }
  console.log(`[solix demo] enabled ${advisors.length} advisors`);

  // 2) Create the sessions. We round-robin across projects so each project
  //    gets a meaningful share, and we vary models so the planet colors mix.
  const sessions: SeededSession[] = [];
  let pid = 90_000;
  for (let i = 0; i < STATUS_PLAN.length; i++) {
    const projectName = PROJECTS[i % PROJECTS.length]!;
    const cwd = join(demoRootCwd, projectName);
    const status = STATUS_PLAN[i]!;
    const id = `demo-${String(i).padStart(2, '0')}-${projectName}`;
    const model = MODELS[i % MODELS.length]!;
    sessions.push({ id, pid, cwd, projectName, model, status });

    await postEvent(base, {
      event: 'session_start',
      pid,
      cwd,
      ts: ts(),
      payload: { session_id: id, model },
    });
    pid += 1;
  }
  await sleep(120);

  // 3) Push each session into the status it's supposed to display.
  let seededSpendUsd = 0;
  let seededTokens = 0;
  for (const s of sessions) {
    const prompt = randomChoice(PROMPTS);
    // Every seeded session represents work someone asked for, so every one
    // gets a prompt — including the ones paused on a permission, which are
    // mid-mission by definition. It also matters for the numbers: tokens
    // attribute to a session's current mission, so a session with no mission
    // silently drops its share of the token count.
    await postEvent(base, {
      event: 'user_prompt_submit',
      pid: s.pid,
      cwd: s.cwd,
      ts: ts(),
      payload: { session_id: s.id, prompt },
    });

    // Spend, before any `stop`. A real session accrues cost while its mission
    // is running and the mission carries the tokens away with it when it
    // completes, so seeding after the stop would bank the dollars and lose
    // every token.
    const usage = usageForSession(s);
    await postJson(base, `/api/sessions/${s.id}/usage`, {
      costUsd: costForUsage(s.model, usage),
      tokens: totalTokens(usage),
    });
    seededSpendUsd += costForUsage(s.model, usage);
    seededTokens += totalTokens(usage);

    if (s.status === 'idle') {
      await postEvent(base, {
        event: 'stop',
        pid: s.pid,
        cwd: s.cwd,
        ts: ts(),
        payload: { session_id: s.id },
      });
    }
    if (s.status === 'awaiting_permission') {
      await postEvent(base, {
        event: 'notification',
        pid: s.pid,
        cwd: s.cwd,
        ts: ts(),
        payload: {
          session_id: s.id,
          tool_name: 'Bash',
          tool_input: { command: 'git push origin main' },
          message: 'Permission for git push',
        },
      });
    }
  }

  // 4) Fire one wave of tool-call comets across the active set so the user
  //    sees motion the instant the browser opens (instead of waiting for the
  //    first ticker beat).
  const active = sessions.filter((s) => s.status === 'active');
  for (const s of active) {
    await postEvent(base, {
      event: 'pre_tool_file',
      pid: s.pid,
      cwd: s.cwd,
      ts: ts(),
      payload: {
        session_id: s.id,
        tool_name: 'Read',
        tool_input: { file_path: randomChoice(TOOL_FILES) },
      },
    });
    await sleep(40);
  }

  // 5) Spawn two subagent moons on two distinct active sessions.
  for (const s of active.slice(0, 2)) {
    await postEvent(base, {
      event: 'pre_tool_task',
      pid: s.pid,
      cwd: s.cwd,
      ts: ts(),
      payload: { session_id: s.id },
    });
  }

  // 6) Realistic context-usage pressure on a couple of planets so the orange/
  //    red flares show up.
  if (active[0]) {
    await postJson(base, `/api/sessions/${active[0].id}/context`, { pct: 62 });
  }
  if (active[1]) {
    await postJson(base, `/api/sessions/${active[1].id}/context`, { pct: 89 });
  }

  // 7) Budget caps on two planets, placed relative to what they have already
  //    spent so the rings are actually in the states they illustrate: one
  //    comfortably under, one past its ceiling. A cap nobody is near renders
  //    the same as no cap at all.
  if (active[0]) {
    const spent = costForUsage(active[0].model, usageForSession(active[0]));
    await postJson(base, `/api/sessions/${active[0].id}/usage`, {
      budgetUsd: Number((spent * 2.5).toFixed(2)),
    });
  }
  if (active[2]) {
    const spent = costForUsage(active[2].model, usageForSession(active[2]));
    await postJson(base, `/api/sessions/${active[2].id}/usage`, {
      budgetUsd: Number((spent * 0.8).toFixed(2)),
    });
  }

  console.log(`[solix demo] seed complete:`);
  console.log(`  • ${sessions.length} sessions across ${PROJECTS.length} projects`);
  console.log(`  • ${advisors.length} advisors enabled`);
  console.log(`  • status mix: 5 active, 18 idle, 3 awaiting_permission, 2 awaiting_input, 1 error, 1 plan_review`);
  console.log(`  • 2 subagent moons, 1 high-context flare`);
  console.log(
    `  • $${seededSpendUsd.toFixed(2)} spent across ${(seededTokens / 1_000_000).toFixed(1)}M tokens, 2 budget caps`,
  );

  return { sessions, advisorIds: advisors.map((a) => a.id) };
}

// ---------------------------------------------------------------------------
// Phase C — live ticker (keeps the galaxy moving until SIGINT)
// ---------------------------------------------------------------------------

type Disposer = () => void;

function startTicker(base: string, state: SeedState): Disposer {
  const intervals: ReturnType<typeof setInterval>[] = [];

  // Cache active/idle pools as mutable state so promotions actually move
  // sessions between groups rather than relying on a stale snapshot.
  const activeIds = new Set(
    state.sessions.filter((s) => s.status === 'active').map((s) => s.id),
  );
  const idleIds = new Set(
    state.sessions.filter((s) => s.status === 'idle').map((s) => s.id),
  );
  const byId = new Map(state.sessions.map((s) => [s.id, s] as const));

  // Comets: fire a tool call on a random active session.
  intervals.push(
    setInterval(() => {
      const candidates = [...activeIds];
      if (candidates.length === 0) return;
      const id = randomChoice(candidates);
      const s = byId.get(id);
      if (!s) return;
      const useBash = Math.random() < 0.4;
      void postEvent(base, {
        event: useBash ? 'pre_tool_bash' : 'pre_tool_file',
        pid: s.pid,
        cwd: s.cwd,
        ts: ts(),
        payload: useBash
          ? { session_id: s.id, command: randomChoice(TOOL_COMMANDS) }
          : {
              session_id: s.id,
              tool_name: Math.random() < 0.5 ? 'Read' : 'Edit',
              tool_input: { file_path: randomChoice(TOOL_FILES) },
            },
      });
      // A tool call costs money, so the counters have to move with it.
      // Without this the spend figure freezes the moment the seed finishes
      // and the budget rings never fill, which is the opposite of the point.
      const turn: TokenUsage = {
        input_tokens: 600 + Math.floor(Math.random() * 900),
        cache_read_input_tokens: 4_000 + Math.floor(Math.random() * 6_000),
        cache_creation_input_tokens: Math.floor(Math.random() * 500),
        output_tokens: 300 + Math.floor(Math.random() * 800),
      };
      void postJson(base, `/api/sessions/${s.id}/usage`, {
        costUsd: costForUsage(s.model, turn),
        tokens: totalTokens(turn),
      });
    }, TICKER_COMET_MS),
  );

  // Ring transitions: promote one idle to active, or vice-versa.
  intervals.push(
    setInterval(() => {
      if (Math.random() < 0.5 && idleIds.size > 0) {
        const id = randomChoice([...idleIds]);
        const s = byId.get(id);
        if (!s) return;
        idleIds.delete(id);
        activeIds.add(id);
        void postEvent(base, {
          event: 'user_prompt_submit',
          pid: s.pid,
          cwd: s.cwd,
          ts: ts(),
          payload: { session_id: id, prompt: randomChoice(PROMPTS) },
        });
      } else if (activeIds.size > 1) {
        const id = randomChoice([...activeIds]);
        const s = byId.get(id);
        if (!s) return;
        activeIds.delete(id);
        idleIds.add(id);
        void postEvent(base, {
          event: 'stop',
          pid: s.pid,
          cwd: s.cwd,
          ts: ts(),
          payload: { session_id: id },
        });
      }
    }, TICKER_PROMOTE_MS),
  );

  // Mission churn: finish a mission on an active session, then start a new
  // one on a different active session.
  intervals.push(
    setInterval(() => {
      const actives = [...activeIds];
      if (actives.length < 2) return;
      const finisher = byId.get(randomChoice(actives))!;
      const starter = byId.get(
        randomChoice(actives.filter((id) => id !== finisher.id)),
      )!;
      void postEvent(base, {
        event: 'stop',
        pid: finisher.pid,
        cwd: finisher.cwd,
        ts: ts(),
        payload: { session_id: finisher.id },
      });
      void postEvent(base, {
        event: 'user_prompt_submit',
        pid: starter.pid,
        cwd: starter.cwd,
        ts: ts(),
        payload: { session_id: starter.id, prompt: randomChoice(PROMPTS) },
      });
    }, TICKER_MISSION_MS),
  );

  // Fresh permission request — raises the red flare + Decision Queue card.
  intervals.push(
    setInterval(() => {
      const actives = [...activeIds];
      if (actives.length === 0) return;
      const s = byId.get(randomChoice(actives));
      if (!s) return;
      void postEvent(base, {
        event: 'notification',
        pid: s.pid,
        cwd: s.cwd,
        ts: ts(),
        payload: {
          session_id: s.id,
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf node_modules' },
          message: 'Permission for destructive shell command',
        },
      });
    }, TICKER_PERMISSION_MS),
  );

  // Advisor invoke — surfaces a toast + Audit row.
  intervals.push(
    setInterval(() => {
      if (state.advisorIds.length === 0 || activeIds.size === 0) return;
      const advisorId = randomChoice(state.advisorIds);
      const targetSessionId = randomChoice([...activeIds]);
      void postJson(
        base,
        `/api/advisors/${encodeURIComponent(advisorId)}/invoke`,
        {
          targetSessionId,
          prompt: 'Spot-check this session before the next mission.',
        },
      );
    }, TICKER_ADVISOR_MS),
  );

  return () => {
    for (const i of intervals) clearInterval(i);
  };
}

// ---------------------------------------------------------------------------
// Phase D — teardown
// ---------------------------------------------------------------------------

function registerTeardown(opts: {
  child: ChildProcess | null;
  stopTicker: Disposer | null;
  keep: boolean;
}): void {
  let torn = false;
  const onSignal = async (sig: NodeJS.Signals): Promise<void> => {
    if (torn) return;
    torn = true;
    console.log(`\n[solix demo] received ${sig} — tearing down…`);
    if (opts.stopTicker) opts.stopTicker();
    // Kill the child reliably (SIGTERM → SIGKILL) and wait for it to exit, so
    // Ctrl+C never leaves an orphaned server squatting on the port/DB.
    if (opts.child) await killChildHard(opts.child);
    if (!opts.keep) {
      for (const p of [DEMO_DB_PATH, `${DEMO_DB_PATH}-shm`, `${DEMO_DB_PATH}-wal`, DEMO_PID_PATH]) {
        try {
          if (existsSync(p)) unlinkSync(p);
        } catch {
          /* ignore */
        }
      }
      console.log(`[solix demo] sandbox cleaned up.`);
    } else {
      console.log(`[solix demo] --keep set; ${DEMO_DB_PATH} preserved.`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => void onSignal('SIGINT'));
  process.on('SIGTERM', () => void onSignal('SIGTERM'));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function tryOpenBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === 'darwin'
      ? 'open'
      : platform === 'win32'
        ? 'start'
        : 'xdg-open';
  try {
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    // A missing opener (e.g. no `xdg-open` on a headless server / CI) makes
    // spawn emit an *async* 'error' event, not a sync throw — without this
    // handler that becomes an unhandled error and crashes `solix demo`.
    child.on('error', () => {
      /* headless or no opener available; user navigates manually */
    });
    child.unref();
  } catch {
    /* headless or no opener available; user can still navigate manually */
  }
}

export async function demoCmd(opts: DemoOptions = {}): Promise<void> {
  const preferredPort = opts.port ?? 4242;
  const demoRootCwd = opts.cwd ?? join(homedir(), 'demo-projects');

  let boot: BootResult | null = null;
  if (opts.noServer) {
    if (!(await waitForServer(preferredPort, 1000))) {
      console.error(
        `[solix demo] --no-server set but nothing is listening on ${preferredPort}. Start a server first.`,
      );
      process.exitCode = 1;
      return;
    }
    boot = { child: null, port: preferredPort, base: baseUrl(preferredPort) };
  } else {
    boot = await bootSandbox(preferredPort);
    if (!boot) {
      process.exitCode = 1;
      return;
    }
    console.log(
      `[solix demo] server up at ${boot.base} (sandbox DB at ${DEMO_DB_PATH})`,
    );
  }

  const seed = await richSeed(boot.base, demoRootCwd);
  console.log(`[solix demo] open ${boot.base} to see the galaxy.`);
  void tryOpenBrowser(boot.base);

  if (opts.noTicker) {
    console.log(
      `[solix demo] --no-ticker set; static snapshot only. Exiting.`,
    );
    // Don't kill the spawned server — user explicitly opted into a static
    // snapshot they presumably want to look at.
    return;
  }

  console.log(
    `[solix demo] live ticker running. Press Ctrl+C to stop and tear down.`,
  );
  const stopTicker = startTicker(boot.base, seed);
  registerTeardown({
    child: boot.child,
    stopTicker,
    keep: opts.keep ?? false,
  });

  // Park the process so SIGINT can drive the teardown.
  await new Promise<void>(() => {
    /* never resolves */
  });
}
