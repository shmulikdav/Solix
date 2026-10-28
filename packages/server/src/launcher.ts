import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { nanoid } from 'nanoid';
import { costForUsage, type Model } from '@solix/shared';
import type { DB } from './db.js';
import type { Broadcaster } from './broadcaster.js';
import { ensureProject } from './state/projects.js';
import { getGovernanceLevel, shouldGateAtAll } from './state/governance.js';
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
  /**
   * The running process, while it runs.
   *
   * Kept so Terminate can actually terminate. `terminate_session` was a bare
   * `break` in the websocket handler, so the danger-red Terminate button —
   * on a list where you can select every agent at once — did nothing at all
   * and said nothing either.
   */
  child?: ChildProcess;
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
/**
 * What an unreachable or slow gate should do.
 *
 * `deny` is right wherever a human is meant to be deciding. `fail-open` is
 * for `observe`, which means "watch, hold nothing": the denylist still runs
 * whenever Solix is up, and a dead Solix never blocks a task on the one
 * setting whose whole point is to stay out of the way.
 */
export type GatePolicy = 'deny' | 'fail-open';

export function containmentGateEnv(
  env: NodeJS.ProcessEnv = process.env,
  policy: GatePolicy = 'deny',
): {
  SOLIX_GATE_ENABLED?: string;
  SOLIX_GATE_POLICY?: string;
} {
  if (containmentOptedOut(env)) return {};
  return {
    SOLIX_GATE_ENABLED: '1',
    SOLIX_GATE_POLICY: env.SOLIX_GATE_POLICY ?? policy,
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
function buildSpawnEnv(
  contain = false,
  /**
   * Switch the gate on WITHOUT scrubbing the environment.
   *
   * Containment bundles two separate things: strip the env to an allowlist,
   * and inject the fail-closed gate. That bundle is right for an autonomous
   * worker — least privilege for something nobody is watching. It is wrong
   * for a task *you* launched and are sitting in front of: scrubbing would
   * take away the API keys and tooling your own shell has, to protect you
   * from yourself.
   *
   * A New task wants the second half only. Your environment, held commands.
   */
  gateOnly = false,
  policy: GatePolicy = 'deny',
): NodeJS.ProcessEnv | undefined {
  return buildSpawnEnvImpl(contain, gateOnly, policy);
}

/** Exported for tests: the env a child is actually handed. */
export const buildSpawnEnvForTest = (
  contain: boolean,
  gateOnly: boolean,
): NodeJS.ProcessEnv | undefined => buildSpawnEnvImpl(contain, gateOnly);

function buildSpawnEnvImpl(
  contain: boolean,
  gateOnly: boolean,
  policy: GatePolicy = 'deny',
): NodeJS.ProcessEnv | undefined {
  const scrub =
    contain ||
    process.env.SOLIX_ENV_SCRUB === '1' ||
    (process.env.SOLIX_SANDBOX_CMD ?? '').trim() !== '';

  if (!scrub) {
    if (!gateOnly) return undefined;
    const gate = containmentGateEnv(process.env, policy);
    // Opted out of containment entirely → nothing to inject, inherit as before.
    if (Object.keys(gate).length === 0) return undefined;
    return { ...process.env, ...gate };
  }

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
  if (contain) Object.assign(env, containmentGateEnv(process.env, policy));
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
 * Resolve the agent binary to spawn. Overridable per runtime so a non-standard
 * install (nvm shim, custom prefix, a wrapper script) works without PATH
 * surgery — and so the end-to-end launcher test can drive the REAL spawn path
 * against a stand-in binary instead of mocking it away.
 */
/**
 * Turn a raw spawn failure into something that points at the real cause.
 *
 * Node reports a missing CWD as `spawn claude ENOENT` — naming the COMMAND,
 * not the directory. A plan whose project path does not exist therefore fails
 * with a message that reads as a broken Claude Code install, which sends you
 * looking in exactly the wrong place. (This is not hypothetical: it is how a
 * plain unexpanded `~/project` presented.)
 */
export function explainSpawnError(
  err: NodeJS.ErrnoException,
  cwd: string,
  bin: string,
): string {
  if (err.code === 'ENOENT') {
    if (cwd && !existsSync(cwd)) {
      return `project directory does not exist: ${cwd}`;
    }
    // "Install Claude Code" is the wrong advice for the most common case:
    // nvm. The binary is installed, on a PATH this server does not have —
    // which is what SOLIX_CLAUDE_BIN is for, so name it rather than sending
    // someone to reinstall software they already have.
    return (
      `could not run "${bin}" — not found on this server's PATH. ` +
      'If Claude Code is installed and on a different PATH (nvm, a custom ' +
      'prefix), set SOLIX_CLAUDE_BIN to its full path — `which claude` in ' +
      'the shell where it works — and restart Solix.'
    );
  }
  if (err.code === 'EACCES') {
    return (
      `"${bin}" is not executable (${err.message}). Check its permissions, ` +
      'or point SOLIX_CLAUDE_BIN at the real binary.'
    );
  }
  return err.message;
}

export function resolveAgentBin(runtime: 'claude' | 'codex' = 'claude'): string {
  const override =
    runtime === 'codex'
      ? process.env.SOLIX_CODEX_BIN
      : process.env.SOLIX_CLAUDE_BIN;
  const trimmed = (override ?? '').trim();
  return trimmed || runtime;
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
    const r = spawnSync(resolveAgentBin('claude'), ['--help'], {
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

/**
 * Test-only: clear the cached capability probes so a suite can point
 * SOLIX_CLAUDE_BIN/SOLIX_CODEX_BIN at a different binary and re-probe.
 */
export function resetAgentCapsForTests(): void {
  claudeCapsCache = null;
  codexCapsCache = null;
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

/** Build the `codex exec` argv (Layer B: dispatch a Codex worker). Pure
 *  (caps injected) so it's unit-testable without the Codex CLI. `--json`
 *  gives structured output for cost parity. */
export function buildCodexExecArgs(
  opts: { model?: string; prompt: string },
  caps: { json: boolean },
): string[] {
  const args = ['exec'];
  if (caps.json) args.push('--json');
  if (opts.model) args.push('--model', opts.model);
  args.push(opts.prompt);
  return args;
}

/** Probe (cached) whether the installed `codex` supports `exec --json`. */
let codexCapsCache: { json: boolean } | null = null;
function codexCaps(): { json: boolean } {
  if (codexCapsCache) return codexCapsCache;
  let help = '';
  try {
    const r = spawnSync(resolveAgentBin('codex'), ['exec', '--help'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    help = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  } catch {
    /* codex missing → no json; still spawns exec and falls back to raw stdout */
  }
  codexCapsCache = { json: help.includes('--json') };
  return codexCapsCache;
}

/**
 * Best-effort parse of `codex exec --json` output → assistant text + cost.
 * Codex emits newline-delimited JSON events; we take the last assistant/result
 * text and sum any token usage we can find. Returns null if nothing parses (the
 * caller falls back to raw stdout). NEEDS REAL CODEX TO VALIDATE — the rollout
 * schema is semi-stable, so this is intentionally lenient.
 */
/**
 * Parse `codex exec --json` NDJSON → assistant text + cost.
 *
 * EXPERIMENTAL / UNVERIFIED: written against Codex's documented-at-the-time
 * event stream, never run against the real binary (see README). It is therefore
 * deliberately tolerant — it scans every JSON line, accepts several text and
 * usage shapes, and ignores events it doesn't recognize, so a schema drift
 * degrades to "no cost / no text" rather than throwing.
 *
 * Codex reports TOKEN USAGE, not a dollar figure, so unlike Claude Code there's
 * no `total_cost_usd` to read: we price the usage locally via the shared
 * pricing table. Without this, a Codex worker's spend was always undefined and
 * contributed nothing to plan budgets — i.e. the budget cap silently did not
 * apply to Codex tasks.
 */
export function parseCodexJsonResult(
  stdout: string,
  model?: string,
): { result: string; isError: boolean; costUsd?: number } | null {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'));
  if (lines.length === 0) return null;
  let result = '';
  let costUsd: number | undefined;
  let codexUsageCost: number | undefined;
  let isError = false;
  for (const line of lines) {
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof obj.total_cost_usd === 'number') costUsd = obj.total_cost_usd;
    // Codex reports usage instead of cost — price it locally. Accept the usage
    // object at the top level or nested under a turn/completed envelope, in
    // either snake_case or camelCase.
    const usageRaw =
      (obj.usage as Record<string, unknown> | undefined) ??
      ((obj.turn as Record<string, unknown> | undefined)?.usage as
        | Record<string, unknown>
        | undefined) ??
      ((obj.info as Record<string, unknown> | undefined)?.usage as
        | Record<string, unknown>
        | undefined);
    if (usageRaw && costUsd === undefined) {
      const num = (...keys: string[]): number => {
        for (const k of keys) {
          const v = usageRaw[k];
          if (typeof v === 'number') return v;
        }
        return 0;
      };
      const usage = {
        input_tokens: num('input_tokens', 'inputTokens', 'prompt_tokens'),
        output_tokens: num('output_tokens', 'outputTokens', 'completion_tokens'),
        cache_read_input_tokens: num(
          'cache_read_input_tokens',
          'cacheReadInputTokens',
          'cached_input_tokens',
        ),
        cache_creation_input_tokens: num(
          'cache_creation_input_tokens',
          'cacheCreationInputTokens',
        ),
      };
      if (usage.input_tokens || usage.output_tokens) {
        codexUsageCost = costForUsage(model ?? 'gpt-5', usage);
      }
    }
    // Error signals across plausible shapes.
    if (
      obj.is_error === true ||
      obj.type === 'error' ||
      typeof obj.error === 'string' ||
      (typeof obj.error === 'object' && obj.error !== null)
    ) {
      isError = true;
      if (typeof obj.error === 'string' && !result) result = obj.error;
    }
    // Capture the latest assistant text we can find, across common shapes.
    const text =
      typeof obj.result === 'string'
        ? obj.result
        : typeof obj.text === 'string'
          ? obj.text
          : typeof (obj.message as Record<string, unknown>)?.content === 'string'
            ? ((obj.message as Record<string, unknown>).content as string)
            : '';
    if (text) result = text;
  }
  // Prefer an explicit cost if the stream ever provides one; else use the
  // locally-priced token usage.
  const finalCost = costUsd ?? codexUsageCost;
  if (!result && finalCost === undefined && !isError) return null;
  return { result, isError, costUsd: finalCost };
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
    // Success is explicitly `subtype: 'success'`; the failure arms use
    // error_max_turns / error_during_execution / error_max_budget_usd / … and
    // that set is not closed, so treat any non-success subtype on a result
    // envelope as a failure rather than enumerating known error values. (A
    // build that sets an error subtype WITHOUT is_error would otherwise read
    // as success.) Guarded on type==='result' so a stray non-result object
    // isn't mis-flagged.
    const subtype = typeof obj.subtype === 'string' ? obj.subtype : undefined;
    const isError =
      obj.is_error === true ||
      (subtype?.startsWith('error') ?? false) ||
      (obj.type === 'result' && subtype != null && subtype !== 'success');
    // The failure arms carry `errors: string[]` and NO `result`, so fall back
    // to them — otherwise a failed run surfaces with an empty reason and the
    // retry prompt has nothing to correct against.
    const errors = Array.isArray(obj.errors)
      ? obj.errors.filter((e): e is string => typeof e === 'string')
      : [];
    const result =
      typeof obj.result === 'string' && obj.result !== ''
        ? obj.result
        : typeof obj.text === 'string' && obj.text !== ''
          ? obj.text
          : errors.join('; ');
    return {
      result,
      isError,
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
   * Signal the process behind a session, if Solix started it.
   *
   * Returns whether anything was actually signalled. Solix can only stop
   * what it spawned: for a session running in the user's own terminal it has
   * a PID from the hook, but killing that would reach into a foreground
   * shell it does not own. The caller owns the state transition and the
   * message — this owns only the signal, so there is one place that decides
   * what "terminated" means.
   */
  killSession(sessionId: string): boolean {
    const record = this.internalTasks.get(sessionId);
    const child = record?.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return false;
    }
    try {
      child.kill('SIGTERM');
    } catch (err) {
      console.warn(`[launcher] kill failed for ${sessionId}:`, err);
      return false;
    }
    // SIGKILL after a grace period if it lingers — the same pattern the plan
    // abort path uses.
    const grace = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 2000);
    grace.unref?.();
    record.child = undefined;
    return true;
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
      const spawnSpec = sandboxWrap(resolveAgentBin('claude'), [
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
      // Say what actually went wrong, and say plainly that what appears is
      // not a real agent. This claimed "claude binary not found" for any
      // spawn throw and called the result "synthetic" — a word that does not
      // tell anyone the planet they are looking at is fabricated, with a
      // random PID, counting toward their fleet.
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'warn',
        message:
          `Could not start ${advisor.codename}: ` +
          `${explainSpawnError(err as NodeJS.ErrnoException, cwd, resolveAgentBin('claude'))} ` +
          '— showing a placeholder planet, which is not a running agent.',
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
    /** Mark this as an autonomous launch (currently: a fired routine). The
     *  session is pre-created with this role and correlated via
     *  `--session-id`, so the containment gate can recognise it: its tool
     *  calls are governed by the denylist and safe ones auto-allow, instead
     *  of queueing for a human who isn't there. Implies containment. */
    sessionRole?: 'routine';
  }): { ok: boolean; sessionId?: string } {
    if (!opts.initialPrompt.trim()) return { ok: false };

    /**
     * Two different questions, and they used to be one.
     *
     * `holdForHuman` is the dial: does a sensitive call stop and wait for
     * you? That is off at `observe`, by definition.
     *
     * Whether the gate is *injected at all* is separate, because the
     * command denylist is a floor that does not move with the dial — and
     * the gate env is the only way the hook ever calls the server, which
     * is the only place the denylist runs. Keying injection off the dial
     * meant a New task at `observe` ran `sudo` with nothing in its way,
     * while README.md and the level description both promised otherwise.
     * Verified against a real agent before changing it.
     *
     * So: always inject, and let the policy carry the difference.
     * `observe` fails open — the floor holds while Solix is up, and a dead
     * Solix never blocks a task on the setting that means "stay out of my
     * way".
     */
    const holdForHuman = shouldGateAtAll(getGovernanceLevel(this.db));
    const gatePolicy: GatePolicy = holdForHuman ? 'deny' : 'fail-open';

    if (opts.useAgentView) {
      // `claude --bg` hands the session to the Agent View supervisor. If that
      // daemon is already running it does NOT inherit the env we set here, so
      // the gate would apply or not depending on whether something else
      // happened to start the daemon first. A safety guarantee that holds
      // nondeterministically is worse than one that is plainly absent, so
      // when the gate is meant to be on we take the path we control.
      if (!holdForHuman) {
        // NOTE: a supervisor-hosted session does not inherit the env we set,
        // so the denylist cannot reach it either. At `observe` with Agent
        // View explicitly ticked, that is the trade the user asked for; at
        // any other level we take the path we control, below.
        return this.dispatchAgentView({
          cwd: opts.cwd,
          model: opts.model,
          initialPrompt: opts.initialPrompt,
          agentName: opts.agentName,
        });
      }
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'info',
        message:
          'Launched without Agent View so its commands can be held for you. `solix level observe` restores it.',
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

    // An autonomous launch pre-creates its planet row with a UUID and passes
    // it as --session-id, so the hooks enrich THAT row and the gate can see
    // the role. Human-initiated launches keep the original synthetic id and
    // ungated behaviour — this path is opt-in and changes nothing for them.
    let sessionId = `task-${nanoid(8)}`;
    if (opts.sessionRole) {
      const caps = claudeCaps();
      const correlated = randomUUID();
      if (caps.sessionId) {
        args.push('--session-id', correlated);
        sessionId = correlated;
        this.preparePlanetRow(correlated, spawnCwd, opts.sessionRole, opts.model);
      } else {
        console.warn(
          '[launcher] claude lacks --session-id; routine will run ungated',
        );
      }
    }
    args.push(opts.initialPrompt);

    return this.spawnPrint({
      sessionId,
      cwd: spawnCwd,
      args,
      isFollowUp: false,
      worktreePath,
      budgetUsd: opts.budgetUsd,
      goalId: opts.goalId,
      contain: Boolean(opts.sessionRole),
      // Not contained — this is your task, so it keeps your environment — but
      // always gated, so the denylist applies and, above `observe`, risky
      // commands stop and wait for you.
      gate: true,
      gatePolicy,
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
      const spawnSpec = sandboxWrap(resolveAgentBin('claude'), args);
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

  /**
   * Pre-create the session row for an autonomous launch, tagged with its role,
   * so the containment gate can identify it the moment its first hook fires.
   * Mirrors the orchestrator's worker/verifier planet rows.
   */
  private preparePlanetRow(
    sessionId: string,
    cwd: string,
    role: 'routine',
    model?: Model,
  ): void {
    try {
      const project = ensureProject(this.db, cwd);
      upsertSession(this.db, {
        id: sessionId,
        pid: 0,
        projectId: project.id,
        cwd,
        origin: 'internal',
        model: model ?? 'default',
        kind: 'user',
        sessionRole: role,
      });
      const active = setSessionStatus(this.db, sessionId, 'active');
      if (active) {
        this.broadcaster.broadcast({ type: 'session_upsert', session: active });
      }
    } catch (err) {
      // Never let bookkeeping stop the launch; worst case it runs ungated and
      // the warning below says so.
      console.warn('[launcher] could not pre-create routine session row', err);
    }
  }

  private spawnPrint(opts: {
    sessionId: string;
    cwd: string;
    args: string[];
    isFollowUp: boolean;
    worktreePath?: string;
    budgetUsd?: number;
    goalId?: string;
    /** Scrub the env to an allowlist AND gate (autonomous launches). */
    contain?: boolean;
    /** Gate without scrubbing — a task you launched, keeping your env. */
    gate?: boolean;
    /** What an unreachable gate does. `fail-open` at `observe`. */
    gatePolicy?: GatePolicy;
  }): { ok: boolean; sessionId?: string } {
    let child: ChildProcess;
    try {
      const spawnSpec = sandboxWrap(resolveAgentBin('claude'), opts.args);
      child = spawn(spawnSpec.file, spawnSpec.args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: buildSpawnEnv(opts.contain, opts.gate, opts.gatePolicy),
      });
    } catch (err) {
      // explainSpawnError lives 800 lines up for exactly this, and the async
      // child.on('error') handler below already uses it. This hardcoded one
      // cause — note the template literal with nothing to interpolate — for
      // any synchronous spawn throw: EACCES on a non-executable shim, a
      // SOLIX_SANDBOX_CMD that is not installed, a bad argv. It sent people
      // to reinstall software they already had, while the real error went
      // only to a console they were not reading.
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'error',
        message: explainSpawnError(
          err as NodeJS.ErrnoException,
          opts.cwd,
          resolveAgentBin('claude'),
        ),
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
        child,
      });
    } else {
      const rec = this.internalTasks.get(opts.sessionId);
      if (rec) rec.child = child;
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
        message: `Task error: ${explainSpawnError(err, opts.cwd, resolveAgentBin('claude'))}`,
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
    /** Agent runtime to run ('claude' default, 'codex'). */
    runtime?: 'claude' | 'codex';
  }): Promise<{ ok: boolean; output: string; error?: string; costUsd?: number }> {
    return new Promise((resolve) => {
      // Honor an already-aborted signal before spawning anything.
      if (opts.signal?.aborted) {
        resolve({ ok: false, output: '', error: 'aborted' });
        return;
      }
      // Pick the runtime: Claude Code (default) or Codex. Each has its own
      // binary, arg builder, and JSON-result parser; everything downstream
      // (env, abort, cost tally) is shared.
      const runtime = opts.runtime ?? 'claude';
      let bin: string;
      let args: string[];
      let useJson: boolean;
      let parseResult: (
        stdout: string,
      ) => { result: string; isError: boolean; costUsd?: number } | null;
      if (runtime === 'codex') {
        const cc = codexCaps();
        bin = resolveAgentBin('codex');
        // task.model is usually a Claude alias; only forward an OpenAI/Codex id.
        const codexModel = /gpt|codex/i.test(opts.model ?? '')
          ? opts.model
          : undefined;
        args = buildCodexExecArgs({ model: codexModel, prompt: opts.prompt }, cc);
        useJson = cc.json;
        parseResult = (out) => parseCodexJsonResult(out, codexModel ?? opts.model);
      } else {
        const caps = claudeCaps();
        bin = resolveAgentBin('claude');
        args = buildPrintArgs(
          { model: opts.model, sessionId: opts.sessionId, prompt: opts.prompt },
          caps,
        );
        useJson = caps.jsonOutput;
        parseResult = parseClaudeJsonResult;
      }
      // Base (scrubbed for contained workers) env + the task's granted secrets.
      const baseEnv = buildSpawnEnv(opts.contain);
      const spawnEnv = opts.env
        ? { ...(baseEnv ?? process.env), ...opts.env }
        : baseEnv;
      let child: ChildProcess;
      try {
        const spec = sandboxWrap(bin, args);
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
          error: `${bin} spawn failed: ${(err as Error).message}`,
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
        resolve({
          ok: false,
          output: stdout,
          error: explainSpawnError(err, opts.cwd, bin),
        });
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
          const parsed = parseResult(stdout);
          if (parsed) {
            resolve({
              ok: code === 0 && !parsed.isError,
              output: parsed.result,
              costUsd: parsed.costUsd,
              // Carry the model's own reason through, so the task thread and
              // the retry prompt get something actionable.
              error: parsed.isError
                ? parsed.result || `${bin} reported an error`
                : undefined,
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
            error: stderr.trim().slice(0, 300) || `${bin} exited with code ${code}`,
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
