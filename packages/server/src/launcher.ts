import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { nanoid } from 'nanoid';
import type { Model } from '@solix/shared';
import type { DB } from './db.js';
import type { Broadcaster } from './broadcaster.js';
import { ensureProject } from './state/projects.js';
import {
  getSession,
  setSessionBudget,
  setSessionGoal,
  setSessionStatus,
  upsertSession,
} from './state/sessions.js';
import {
  getAdvisor,
  setAdvisorPinned,
} from './state/advisors.js';

interface PinnedProcess {
  advisorId: string;
  pid: number;
  child?: ChildProcess;
  syntheticSessionId?: string;
}

interface InternalTaskRecord {
  cwd: string;
  // Last sessionId returned by claude --print on this cwd, if any. Used to
  // pass --resume on follow-up prompts so multi-turn works.
  lastClaudeSessionId?: string;
  // When the user launched into a Solix-managed worktree, the worktree path
  // is stored here so the SessionStart hook can persist it on the session.
  worktreePath?: string;
  // Sprint M: budget cap + goal recorded at launch so the SessionStart hook
  // can persist them onto the session row (keyed by cwd, like worktreePath).
  budgetUsd?: number;
  goalId?: string;
}

interface WorktreeResult {
  path: string;
  created: boolean;
}

/**
 * Resolve (or create) a git worktree for `branch` rooted at the repo
 * containing `repoCwd`. Returns the worktree path so the launcher can use
 * it as the spawn cwd. Reuses an existing worktree if one is already
 * registered at the same path. New branches are created from `baseRef`
 * (default 'HEAD').
 */
function ensureWorktree(opts: {
  repoCwd: string;
  branch: string;
  baseRef?: string;
}): WorktreeResult {
  const repoRoot = (() => {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: opts.repoCwd,
      encoding: 'utf8',
    });
    if (r.status !== 0) {
      throw new Error(`not a git repository: ${opts.repoCwd}`);
    }
    return (r.stdout ?? '').trim();
  })();

  const repoName = basename(repoRoot);
  const safeBranch = opts.branch.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const worktreesDir = join(homedir(), '.solix', 'worktrees');
  const path = join(worktreesDir, `${repoName}-${safeBranch}`);

  // Already registered? Reuse.
  const list = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (list.status === 0 && (list.stdout ?? '').includes(`worktree ${path}`)) {
    return { path, created: false };
  }

  mkdirSync(worktreesDir, { recursive: true });

  // Branch exists locally? Use it; otherwise create from baseRef.
  const branchProbe = spawnSync(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${opts.branch}`],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const args =
    branchProbe.status === 0
      ? ['worktree', 'add', path, opts.branch]
      : ['worktree', 'add', path, '-b', opts.branch, opts.baseRef ?? 'HEAD'];
  const add = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (add.status !== 0) {
    throw new Error(
      `git worktree add failed: ${(add.stderr ?? '').slice(0, 280)}`,
    );
  }
  return { path, created: true };
}

const FAKE_CLAUDE = process.env.SOLIX_FAKE_CLAUDE === '1';

/** Safe-by-default containment opt-out: a user can turn OFF the auto-enabled
 *  worker gate with SOLIX_CONTAINMENT=0 or an explicit SOLIX_GATE_ENABLED=0. */
export function containmentOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SOLIX_CONTAINMENT === '0' || env.SOLIX_GATE_ENABLED === '0';
}

/** The gate env to inject into a contained worker: the fail-closed tool-call
 *  gate, unless the user opted out. Pure (env injected) so it's unit-testable. */
export function containmentGateEnv(env: NodeJS.ProcessEnv = process.env): {
  SOLIX_GATE_ENABLED?: string;
  SOLIX_GATE_POLICY?: string;
} {
  if (containmentOptedOut(env)) return {};
  return {
    SOLIX_GATE_ENABLED: '1',
    SOLIX_GATE_POLICY: env.SOLIX_GATE_POLICY ?? 'deny',
  };
}

/**
 * Process env for Solix-launched agents. For a **contained** worker/verifier
 * (`contain`), scrub to an allowlist AND — safe-by-default — inject the
 * tool-call gate (`SOLIX_GATE_ENABLED=1` + fail-closed `SOLIX_GATE_POLICY=deny`)
 * so the command denylist governs it out of the box, unless the user opted out.
 * For non-contained launches it returns `undefined` (inherit ambient env) unless
 * the global `SOLIX_ENV_SCRUB`/sandbox flags ask for a scrub. Auth + gate vars
 * are always preserved so `claude` and its hooks still work.
 */
function buildSpawnEnv(contain = false): NodeJS.ProcessEnv | undefined {
  const scrub =
    contain ||
    process.env.SOLIX_ENV_SCRUB === '1' ||
    (process.env.SOLIX_SANDBOX_CMD ?? '').trim() !== '';
  if (!scrub) return undefined;

  const allow = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'LANG',
    'LC_ALL',
    'TERM',
    'TMPDIR',
    'TZ',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'SOLIX_HOME',
    'SOLIX_HOST',
    'SOLIX_PORT',
    'SOLIX_GATE_ENABLED',
    'SOLIX_GATE_POLICY',
    'SOLIX_GATE_TIMEOUT',
  ];
  const extra = (process.env.SOLIX_ENV_PASSTHROUGH ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const keep = new Set([...allow, ...extra]);

  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  // Always pass through auth / Claude config so the agent can actually run.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_')) {
      env[k] = process.env[k];
    }
  }
  // Safe-by-default: a Solix-launched worker/verifier gets the gate + a
  // fail-closed policy so the denylist governs it with zero config, unless the
  // user deliberately opted out.
  if (contain) Object.assign(env, containmentGateEnv());
  return env;
}

/**
 * Optional sandbox wrapper. When `SOLIX_SANDBOX_CMD` is set (e.g.
 * `bwrap --bind <cwd> <cwd> --unshare-net` on Linux, or `sandbox-exec -f
 * profile` on macOS), the spawned `claude` is wrapped by it. Unset → spawn
 * directly (no behavior change). The user supplies the jail; Solix only
 * provides the injection point.
 */
function sandboxWrap(
  file: string,
  args: string[],
): { file: string; args: string[] } {
  const cmd = (process.env.SOLIX_SANDBOX_CMD ?? '').trim();
  if (!cmd) return { file, args };
  const parts = cmd.split(/\s+/);
  const bin = parts[0]!;
  return { file: bin, args: [...parts.slice(1), file, ...args] };
}

/**
 * Probe (once, cached) which flags the installed `claude` supports, so `runOnce`
 * degrades gracefully on older versions. `--session-id` (deterministic worker
 * correlation → containment) and `--output-format` (accurate per-run cost) are
 * both long-standing Claude Code flags, but we don't assume.
 */
let claudeCapsCache: { sessionId: boolean; jsonOutput: boolean } | null = null;
function claudeCaps(): { sessionId: boolean; jsonOutput: boolean } {
  if (claudeCapsCache) return claudeCapsCache;
  let help = '';
  try {
    const r = spawnSync('claude', ['--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    help = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  } catch {
    /* claude missing → both false; runOnce falls back to plain --print */
  }
  claudeCapsCache = {
    sessionId: help.includes('--session-id'),
    jsonOutput: help.includes('--output-format'),
  };
  return claudeCapsCache;
}

/** Build the `claude` argv for a one-shot run. Pure (caps injected) so the
 *  correlation/cost wiring — `--session-id`, `--output-format json` — is
 *  unit-testable without spawning. Flags are gated on the probed capabilities. */
export function buildPrintArgs(
  opts: { model?: string; sessionId?: string; prompt: string },
  caps: { sessionId: boolean; jsonOutput: boolean },
): string[] {
  const args = ['--print'];
  if (caps.jsonOutput) args.push('--output-format', 'json');
  if (opts.model && opts.model !== 'default') args.push('--model', opts.model);
  if (opts.sessionId && caps.sessionId) {
    args.push('--session-id', opts.sessionId);
  }
  args.push(opts.prompt);
  return args;
}

/** Parse `claude -p --output-format json` stdout → the assistant text + cost.
 *  Returns null if it isn't the single-object result envelope we expect. */
export function parseClaudeJsonResult(
  stdout: string,
): { result: string; isError: boolean; costUsd?: number } | null {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof obj !== 'object' || obj === null) return null;
    const result =
      typeof obj.result === 'string'
        ? obj.result
        : typeof obj.text === 'string'
          ? obj.text
          : '';
    return {
      result,
      isError: obj.is_error === true,
      costUsd:
        typeof obj.total_cost_usd === 'number' ? obj.total_cost_usd : undefined,
    };
  } catch {
    return null;
  }
}

export class Launcher {
  private byPid = new Map<number, PinnedProcess>();
  private byAdvisor = new Map<string, PinnedProcess>();
  // Sessions that were spawned by the UI's "+ Task" button. Keyed by the
  // sessionId we synthesize at launch (not Claude's session_id, which arrives
  // via the SessionStart hook later).
  private internalTasks = new Map<string, InternalTaskRecord>();

  constructor(
    private db: DB,
    private broadcaster: Broadcaster,
  ) {}

  /** Returns the advisor role bound to a given pid, if any. */
  advisorRoleForPid(pid: number): string | undefined {
    return this.byPid.get(pid)?.advisorId;
  }

  /**
   * Pin (spawn) an advisor as an always-on Claude Code session.
   * Returns true if the spawn succeeded (or a synthetic session was created).
   */
  pin(advisorId: string, cwd: string): boolean {
    if (this.byAdvisor.has(advisorId)) return true;
    const advisor = getAdvisor(this.db, advisorId);
    if (!advisor) return false;

    if (FAKE_CLAUDE) {
      return this.pinSynthetic(advisor.id, advisor.codename, cwd);
    }

    try {
      const spawnSpec = sandboxWrap('claude', [
        '--agent',
        advisor.id,
        '--no-tty',
      ]);
      const child = spawn(spawnSpec.file, spawnSpec.args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false,
        env: buildSpawnEnv(),
      });

      const pid = child.pid;
      if (!pid) {
        this.broadcaster.broadcast({
          type: 'toast',
          level: 'error',
          message: `Could not spawn claude for ${advisor.codename}`,
        });
        return false;
      }

      const record: PinnedProcess = { advisorId, pid, child };
      this.byPid.set(pid, record);
      this.byAdvisor.set(advisorId, record);
      setAdvisorPinned(this.db, advisorId, true);

      child.on('exit', () => {
        this.cleanup(advisorId, pid);
      });
      child.on('error', (err) => {
        console.warn(`[launcher] ${advisorId} error:`, err.message);
        this.broadcaster.broadcast({
          type: 'toast',
          level: 'warn',
          message: `${advisor.codename} exited (${err.message})`,
        });
        this.cleanup(advisorId, pid);
      });

      return true;
    } catch (err) {
      console.warn(`[launcher] spawn failed for ${advisorId}:`, err);
      // Fall back to a synthetic session so the visuals still light up;
      // user gets a clear toast about what happened.
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'warn',
        message: `claude binary not found — pinned ${advisor.codename} as synthetic`,
      });
      return this.pinSynthetic(advisor.id, advisor.codename, cwd);
    }
  }

  private pinSynthetic(
    advisorId: string,
    codename: string,
    cwd: string,
  ): boolean {
    const project = ensureProject(this.db, cwd);
    const sessionId = `advisor-${advisorId}-${nanoid(6)}`;
    const fakePid = 100000 + Math.floor(Math.random() * 100000);
    const session = upsertSession(this.db, {
      id: sessionId,
      pid: fakePid,
      projectId: project.id,
      cwd,
      origin: 'internal',
      kind: 'advisor',
      advisorRole: advisorId,
    });
    setSessionStatus(this.db, sessionId, 'idle');
    setAdvisorPinned(this.db, advisorId, true, sessionId);

    const record: PinnedProcess = {
      advisorId,
      pid: fakePid,
      syntheticSessionId: sessionId,
    };
    this.byPid.set(fakePid, record);
    this.byAdvisor.set(advisorId, record);

    this.broadcaster.broadcast({ type: 'session_upsert', session });
    this.broadcaster.broadcast({
      type: 'toast',
      level: 'info',
      message: `${codename} pinned (always-on)`,
    });
    return true;
  }

  unpin(advisorId: string): boolean {
    const record = this.byAdvisor.get(advisorId);
    if (!record) {
      // Nothing to kill, but still flip the DB state.
      setAdvisorPinned(this.db, advisorId, false);
      return true;
    }
    if (record.child) {
      try {
        record.child.kill('SIGTERM');
      } catch (err) {
        console.warn(`[launcher] kill failed for ${advisorId}:`, err);
      }
    }
    this.cleanup(advisorId, record.pid);
    return true;
  }

  private cleanup(advisorId: string, pid: number): void {
    const record = this.byAdvisor.get(advisorId);
    this.byAdvisor.delete(advisorId);
    this.byPid.delete(pid);
    setAdvisorPinned(this.db, advisorId, false);

    if (record?.syntheticSessionId) {
      setSessionStatus(this.db, record.syntheticSessionId, 'terminated');
      this.broadcaster.broadcast({
        type: 'session_remove',
        sessionId: record.syntheticSessionId,
      });
    }
    const advisor = getAdvisor(this.db, advisorId);
    if (advisor) {
      this.broadcaster.broadcast({ type: 'advisor_upsert', advisor });
    }
  }

  shutdownAll(): void {
    for (const advisorId of [...this.byAdvisor.keys()]) {
      this.unpin(advisorId);
    }
  }

  /**
   * Spawn a fresh `claude --print` task in the given cwd. Hooks fire as
   * usual so the planet appears and animates; when the process exits, the
   * captured stdout becomes a final assistant message in the chat.
   *
   * In FAKE_CLAUDE dev mode the task is synthesized so the visuals work
   * without a real claude binary on PATH.
   */
  launch(opts: {
    cwd: string;
    model?: Model;
    initialPrompt: string;
    worktreeBranch?: string;
    worktreeBaseRef?: string;
    /** Sprint L: when true (and Agent View is available locally),
     * dispatch via `claude --bg` so the resulting background session
     * shows up in both Solix and `claude agents`. Solix's Agent View
     * watcher picks it up from ~/.claude/jobs within ~1 second. */
    useAgentView?: boolean;
    /** Optional subagent name from the Agent View mention syntax
     * (`@code-reviewer fix typos` → agentName: 'code-reviewer'). */
    agentName?: string;
    /** Sprint M: per-session budget cap (USD) + goal to roll up to. */
    budgetUsd?: number;
    goalId?: string;
  }): { ok: boolean; sessionId?: string } {
    if (!opts.initialPrompt.trim()) return { ok: false };

    if (opts.useAgentView) {
      return this.dispatchAgentView({
        cwd: opts.cwd,
        model: opts.model,
        initialPrompt: opts.initialPrompt,
        agentName: opts.agentName,
      });
    }

    let spawnCwd = opts.cwd;
    let worktreePath: string | undefined;
    if (opts.worktreeBranch?.trim()) {
      try {
        const wt = ensureWorktree({
          repoCwd: opts.cwd,
          branch: opts.worktreeBranch.trim(),
          baseRef: opts.worktreeBaseRef?.trim() || undefined,
        });
        spawnCwd = wt.path;
        worktreePath = wt.path;
        this.broadcaster.broadcast({
          type: 'toast',
          level: 'info',
          message: wt.created
            ? `Worktree created at ${wt.path}`
            : `Reusing worktree ${wt.path}`,
        });
      } catch (err) {
        this.broadcaster.broadcast({
          type: 'toast',
          level: 'error',
          message: `Worktree setup failed: ${(err as Error).message}`,
        });
        return { ok: false };
      }
    }

    if (FAKE_CLAUDE) {
      return this.launchSynthetic({
        cwd: spawnCwd,
        model: opts.model,
        initialPrompt: opts.initialPrompt,
        worktreePath,
        budgetUsd: opts.budgetUsd,
        goalId: opts.goalId,
      });
    }
    if (!existsSync(spawnCwd)) {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'error',
        message: `Launch failed: cwd does not exist (${spawnCwd})`,
      });
      return { ok: false };
    }

    const args: string[] = ['--print'];
    if (opts.model) args.push('--model', String(opts.model));
    args.push(opts.initialPrompt);

    const sessionId = `task-${nanoid(8)}`;
    return this.spawnPrint({
      sessionId,
      cwd: spawnCwd,
      args,
      isFollowUp: false,
      worktreePath,
      budgetUsd: opts.budgetUsd,
      goalId: opts.goalId,
    });
  }

  /**
   * Sprint L: dispatch via Anthropic's Agent View daemon. Runs
   * `claude --bg "<prompt>"` so the session is hosted by the
   * supervisor and picked up by Solix's filesystem watcher within ~1s.
   * Returns the short id parsed from claude's output line:
   *   backgrounded · 7c5dcf5d
   */
  private dispatchAgentView(opts: {
    cwd: string;
    model?: Model;
    initialPrompt: string;
    agentName?: string;
  }): { ok: boolean; sessionId?: string } {
    if (FAKE_CLAUDE) {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'info',
        message: '(SOLIX_FAKE_CLAUDE=1) Agent View dispatch skipped',
      });
      return { ok: true };
    }
    if (!existsSync(opts.cwd)) {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'error',
        message: `Agent View dispatch failed: cwd does not exist (${opts.cwd})`,
      });
      return { ok: false };
    }
    const args: string[] = [];
    if (opts.agentName) args.push('--agent', opts.agentName);
    if (opts.model) args.push('--model', String(opts.model));
    args.push('--bg', opts.initialPrompt);

    let child: ChildProcess;
    try {
      const spawnSpec = sandboxWrap('claude', args);
      child = spawn(spawnSpec.file, spawnSpec.args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: buildSpawnEnv(),
      });
    } catch (err) {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'error',
        message: `claude --bg spawn failed: ${(err as Error).message}`,
      });
      return { ok: false };
    }

    let stdout = '';
    child.stdout?.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.on('exit', () => {
      // Parse "backgrounded · <id>" out of the output. The watcher
      // will pick up the new ~/.claude/jobs/<id>/state.json within
      // ~50ms, so we don't need to upsert anything manually here.
      const match = stdout.match(/backgrounded[^a-z0-9]+([a-f0-9]{6,16})/i);
      const shortId = match?.[1];
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'info',
        message: shortId
          ? `Dispatched to Agent View · ${shortId}`
          : 'Dispatched to Agent View',
      });
    });
    return { ok: true };
  }

  sendPromptToInternal(sessionId: string, text: string): boolean {
    if (!text.trim()) return false;
    const session = this.db
      .prepare(
        'SELECT cwd, origin FROM sessions WHERE id = ? LIMIT 1',
      )
      .get(sessionId) as { cwd?: string; origin?: string } | undefined;
    if (!session?.cwd) {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'warn',
        message: `Cannot send prompt: session not found`,
      });
      return false;
    }
    if (session.origin !== 'internal') {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'warn',
        message: `Cannot send prompt: external session — type in your terminal`,
      });
      return false;
    }
    // Sprint M — soft pause: refuse further prompts once an internal session
    // has blown its budget cap, until the cap is raised. (We can't stop an
    // external process, but we can stop feeding this one more work.)
    const full = getSession(this.db, sessionId);
    if (full?.budgetUsd != null && full.costUsd >= full.budgetUsd) {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'warn',
        message: `Budget reached for ${full.name ?? sessionId.slice(0, 8)} ($${full.costUsd.toFixed(2)}/$${full.budgetUsd.toFixed(2)}). Raise the cap to continue.`,
      });
      return false;
    }
    if (FAKE_CLAUDE) {
      this.broadcaster.broadcast({
        type: 'chat_delta',
        sessionId,
        delta: {
          messageId: `fake-a-${Date.now()}`,
          role: 'assistant',
          content: `(SOLIX_FAKE_CLAUDE=1) Pretending to run: ${text.slice(0, 200)}`,
          ts: Date.now(),
          done: true,
        },
      });
      return true;
    }
    const args: string[] = ['--print', '--continue', text];
    return this.spawnPrint({
      sessionId,
      cwd: session.cwd,
      args,
      isFollowUp: true,
    }).ok;
  }

  /** Returns the worktree path the launcher resolved for an internal task,
   * if any. Used by router.onSessionStart to persist worktree_path on the
   * session row when claude reports its session_start hook. */
  worktreePathForInternalCwd(cwd: string): string | undefined {
    for (const rec of this.internalTasks.values()) {
      if (rec.cwd === cwd && rec.worktreePath) return rec.worktreePath;
    }
    return undefined;
  }

  /** Sprint M — budget cap recorded at launch for a cwd, if any. */
  budgetForInternalCwd(cwd: string): number | undefined {
    for (const rec of this.internalTasks.values()) {
      if (rec.cwd === cwd && rec.budgetUsd != null) return rec.budgetUsd;
    }
    return undefined;
  }

  /** Sprint M — goal recorded at launch for a cwd, if any. */
  goalForInternalCwd(cwd: string): string | undefined {
    for (const rec of this.internalTasks.values()) {
      if (rec.cwd === cwd && rec.goalId) return rec.goalId;
    }
    return undefined;
  }

  private spawnPrint(opts: {
    sessionId: string;
    cwd: string;
    args: string[];
    isFollowUp: boolean;
    worktreePath?: string;
    budgetUsd?: number;
    goalId?: string;
  }): { ok: boolean; sessionId?: string } {
    let child: ChildProcess;
    try {
      const spawnSpec = sandboxWrap('claude', opts.args);
      child = spawn(spawnSpec.file, spawnSpec.args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: buildSpawnEnv(),
      });
    } catch (err) {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'error',
        message: `claude binary not found — is Claude Code installed?`,
      });
      console.warn('[launcher] spawn failed', err);
      return { ok: false };
    }

    const pid = child.pid ?? 0;
    if (!opts.isFollowUp) {
      this.internalTasks.set(opts.sessionId, {
        cwd: opts.cwd,
        worktreePath: opts.worktreePath,
        budgetUsd: opts.budgetUsd,
        goalId: opts.goalId,
      });
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr?.setEncoding('utf8').on('data', (c: string) => (stderr += c));

    this.broadcaster.broadcast({
      type: 'toast',
      level: 'info',
      message: `Launched task in ${opts.cwd} (pid ${pid})`,
    });

    child.on('exit', (code) => {
      const text = stdout.trim();
      if (text) {
        // The hook stream already produced session/mission/tool events. This
        // final delta delivers the model's text response into the Chat tab.
        // We use the synthetic sessionId for the FIRST run; for follow-ups
        // we route to the existing sessionId.
        this.broadcaster.broadcast({
          type: 'chat_delta',
          sessionId: opts.sessionId,
          delta: {
            messageId: `task-${opts.sessionId}-${Date.now()}`,
            role: 'assistant',
            content: text,
            ts: Date.now(),
            done: true,
          },
        });
      }
      if (code !== 0) {
        this.broadcaster.broadcast({
          type: 'toast',
          level: 'warn',
          message: `Task exited ${code}${stderr ? `: ${stderr.slice(0, 120)}` : ''}`,
        });
      }
    });

    child.on('error', (err) => {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'error',
        message: `Task error: ${err.message}`,
      });
    });

    return { ok: true, sessionId: opts.sessionId };
  }

  /**
   * Run a one-shot `claude --print` session to completion and resolve with its
   * captured stdout. Used by the Maestro Orchestrator's SessionRunner seam
   * (planner in Phase 1; workers/verifier later). Unlike `spawnPrint`, this
   * awaits the exit and hands back the output instead of broadcasting a
   * chat_delta. A missing binary / non-zero exit resolves `{ ok:false, error }`
   * rather than throwing.
   */
  runOnce(opts: {
    cwd: string;
    prompt: string;
    model?: Model;
    signal?: AbortSignal;
    /** Force env-scrub (Maestro workers/verifiers run contained by default,
     *  not only when the global SOLIX_ENV_SCRUB/sandbox flags are set). */
    contain?: boolean;
    /** Deterministic session id → `claude --session-id <uuid>`, so the worker's
     *  hooks/tool-calls land on the pre-created plan-linked planet row (enabling
     *  containment + the fleet visualization). Must be a UUID. */
    sessionId?: string;
    /** Scoped secrets (granted connections) merged into the worker env. */
    env?: Record<string, string>;
  }): Promise<{ ok: boolean; output: string; error?: string; costUsd?: number }> {
    return new Promise((resolve) => {
      // Honor an already-aborted signal before spawning anything.
      if (opts.signal?.aborted) {
        resolve({ ok: false, output: '', error: 'aborted' });
        return;
      }
      const caps = claudeCaps();
      // Structured output → an accurate per-run cost (total_cost_usd) the
      // orchestrator can tally BEFORE the next budget check (no watcher lag).
      const args = buildPrintArgs(
        { model: opts.model, sessionId: opts.sessionId, prompt: opts.prompt },
        caps,
      );
      const useJson = caps.jsonOutput;
      // Base (scrubbed for contained workers) env + the task's granted secrets.
      const baseEnv = buildSpawnEnv(opts.contain);
      const spawnEnv = opts.env
        ? { ...(baseEnv ?? process.env), ...opts.env }
        : baseEnv;
      let child: ChildProcess;
      try {
        const spec = sandboxWrap('claude', args);
        child = spawn(spec.file, spec.args, {
          cwd: opts.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
          env: spawnEnv,
        });
      } catch (err) {
        resolve({
          ok: false,
          output: '',
          error: `claude spawn failed: ${(err as Error).message}`,
        });
        return;
      }
      let stdout = '';
      let stderr = '';
      let aborted = false;
      // Kill-switch: SIGTERM, then SIGKILL after a short grace if it lingers.
      const onAbort = (): void => {
        aborted = true;
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        const grace = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }, 2000);
        grace.unref?.();
      };
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      const cleanup = (): void =>
        opts.signal?.removeEventListener('abort', onAbort);
      child.stdout?.setEncoding('utf8').on('data', (c: string) => (stdout += c));
      child.stderr?.setEncoding('utf8').on('data', (c: string) => (stderr += c));
      child.on('error', (err) => {
        cleanup();
        resolve({ ok: false, output: stdout, error: err.message });
      });
      child.on('exit', (code) => {
        cleanup();
        if (aborted) {
          resolve({ ok: false, output: stdout, error: 'aborted' });
          return;
        }
        // With --output-format json, stdout is a result envelope carrying the
        // assistant text + total_cost_usd. Parse it; fall back to raw stdout if
        // the shape isn't what we expect (older CC / --verbose array form).
        if (useJson) {
          const parsed = parseClaudeJsonResult(stdout);
          if (parsed) {
            resolve({
              ok: code === 0 && !parsed.isError,
              output: parsed.result,
              costUsd: parsed.costUsd,
              error: parsed.isError ? 'claude reported an error' : undefined,
            });
            return;
          }
        }
        if (code === 0) {
          resolve({ ok: true, output: stdout });
        } else {
          resolve({
            ok: false,
            output: stdout,
            error: stderr.trim().slice(0, 300) || `claude exited with code ${code}`,
          });
        }
      });
    });
  }

  private launchSynthetic(opts: {
    cwd: string;
    model?: Model;
    initialPrompt: string;
    worktreePath?: string;
    budgetUsd?: number;
    goalId?: string;
  }): { ok: boolean; sessionId: string } {
    const project = ensureProject(this.db, opts.cwd);
    const sessionId = `task-${nanoid(8)}`;
    const fakePid = 200000 + Math.floor(Math.random() * 100000);
    upsertSession(this.db, {
      id: sessionId,
      pid: fakePid,
      projectId: project.id,
      cwd: opts.cwd,
      origin: 'internal',
      model: opts.model ?? 'sonnet',
      worktreePath: opts.worktreePath,
    });
    if (opts.budgetUsd != null) setSessionBudget(this.db, sessionId, opts.budgetUsd);
    if (opts.goalId) setSessionGoal(this.db, sessionId, opts.goalId);
    const active = setSessionStatus(this.db, sessionId, 'active');
    if (active)
      this.broadcaster.broadcast({ type: 'session_upsert', session: active });
    this.broadcaster.broadcast({
      type: 'chat_delta',
      sessionId,
      delta: {
        messageId: `u-${sessionId}`,
        role: 'user',
        content: opts.initialPrompt,
        ts: Date.now(),
        done: true,
      },
    });
    setTimeout(() => {
      this.broadcaster.broadcast({
        type: 'chat_delta',
        sessionId,
        delta: {
          messageId: `a-${sessionId}`,
          role: 'assistant',
          content: `(SOLIX_FAKE_CLAUDE=1) Synthetic task complete. In real mode, Solix would have spawned \`claude --print\` at ${opts.cwd}.`,
          ts: Date.now(),
          done: true,
        },
      });
      const idle = setSessionStatus(this.db, sessionId, 'idle');
      if (idle)
        this.broadcaster.broadcast({ type: 'session_upsert', session: idle });
    }, 600);
    return { ok: true, sessionId };
  }
}
