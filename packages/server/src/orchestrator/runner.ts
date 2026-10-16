import type { Model, SessionRole, AgentRuntime } from '@solix/shared';

/**
 * The narrow capability the Orchestrator depends on to run a Claude session —
 * NOT the concrete `Launcher`. This is the seam that makes the orchestrator
 * unit-testable: production wires a launcher-backed implementation; tests pass a
 * fake that returns canned output. (Mira's review.)
 */

export interface RunOnceOpts {
  cwd: string;
  prompt: string;
  model?: Model;
  role: SessionRole;
  /** Which agent runtime to run ('claude' default, 'codex'). */
  runtime?: AgentRuntime;
  /** Pre-allocated session id (Phase 2 dispatch pre-creates the planet row so
   *  the worker↔task correlation is deterministic, not cwd-keyed). Optional for
   *  the Phase-1 planner, which is a transient one-shot. */
  sessionId?: string;
  /** The plan's kill-switch. When it aborts, the runner must terminate the
   *  child process and resolve `{ ok:false, error:'aborted' }` (Sentinel:
   *  containment needs a real kill, not a status flip). */
  signal?: AbortSignal;
  /** Scoped secrets (from granted connections) to inject into the worker's env,
   *  resolved at dispatch — least privilege, never the full host env. */
  env?: Record<string, string>;
}

export interface RunOnceResult {
  ok: boolean;
  /** The session's captured output (e.g. the planner's JSON, a worker's summary). */
  output: string;
  sessionId?: string;
  error?: string;
  /** Accurate cost for this run (from `--output-format json` total_cost_usd), so
   *  the orchestrator can tally spend before the next budget check. */
  costUsd?: number;
}

export interface SessionRunner {
  /**
   * Run a one-shot `claude --print` session to completion and resolve with its
   * captured stdout. Rejects only on truly unexpected errors; a non-zero exit
   * or missing binary resolves with `{ ok: false, error }`.
   */
  runOnce(opts: RunOnceOpts): Promise<RunOnceResult>;
}
