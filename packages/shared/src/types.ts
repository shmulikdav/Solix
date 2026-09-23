export type SessionStatus =
  | 'spawning'
  | 'active'
  | 'idle'
  | 'awaiting_input'
  | 'awaiting_permission'
  | 'plan_review'
  | 'error'
  | 'terminated';

export type Model = 'opus' | 'sonnet' | 'haiku' | 'default' | string;

/** How a session was started.
 *  - external: user ran `claude` themselves; we observe via hooks
 *  - internal: Solix's launcher spawned `claude --print` directly
 *  - agentview: dispatched via Anthropic's Agent View daemon (Sprint L);
 *    Solix observes via the on-disk roster + state.json files
 */
export type SessionOrigin = 'external' | 'internal' | 'agentview';

export type SessionKind = 'user' | 'advisor';

/** v2 Maestro — a session's role within an orchestration plan. Absent for
 *  ordinary (non-plan) sessions. */
export type SessionRole = 'worker' | 'verifier' | 'planner';

export interface Session {
  id: string;
  pid: number;
  cwd: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  model: Model;
  origin: SessionOrigin;
  kind: SessionKind;
  advisorRole?: string;
  parentSessionId?: string;
  contextUsagePct: number;
  currentMissionId?: string;
  lastCompletedMissionId?: string;
  orbitSlot: number;
  name?: string;
  /** When this session was launched into a freshly-created git worktree
   * (Sprint I), the worktree path is stored here. List view renders a
   * branch chip from it. */
  worktreePath?: string;
  /** When the user ran `solix run` (Sprint J) instead of bare `claude`,
   * the wrapper's Unix-socket path is stored here. The SidePanel chat
   * composer becomes write-enabled for sessions where this is set. */
  wrapperSocketPath?: string;
  /** Agent View bridge (Sprint L). When this session is a background
   * session managed by Anthropic's `claude agents` supervisor daemon,
   * its short id (e.g. "7c5dcf5d") goes here. */
  agentViewId?: string;
  /** Auto-generated one-line summary from Agent View's Haiku-class
   * model (refreshes ~every 15s while working). Surfaces in the
   * Mission column / Planet hover label when present. */
  agentViewSummary?: string;
  /** PR URL if the Agent View session opened a pull request. */
  prUrl?: string;
  /** CI status of the PR. Lets the SidePanel render ✓ / ✗ / ⏳ next
   * to the PR chip without re-querying GitHub. */
  prCheckStatus?: 'pending' | 'success' | 'failure' | 'neutral';
  /** Sprint M — running estimated spend for this session in USD, derived
   * from the token usage Claude reports in the transcript × model pricing.
   * An estimate, not a billing figure. */
  costUsd: number;
  /** Optional per-session budget cap in USD. When set, the planet grows a
   * budget ring and a breach raises a Decision Queue alert. */
  budgetUsd?: number;
  /** Goal this session's current mission rolls up to (Sprint M). Drives the
   * constellation grouping in the galaxy view. */
  currentGoalId?: string;
  /** v2 Maestro — when the orchestrator dispatched this session for a plan
   * task, the plan + task it belongs to and its role within the plan. Absent
   * for ordinary sessions. */
  planId?: string;
  planTaskId?: string;
  sessionRole?: SessionRole;
}

export type MissionStatus = 'active' | 'completed' | 'failed' | 'cancelled';

export interface MissionMetrics {
  durationMs?: number;
  totalTokens?: number;
  linesAdded?: number;
  linesRemoved?: number;
  subagentCount: number;
  toolCallCount: number;
}

export interface Mission {
  id: string;
  sessionId: string;
  startedAt: number;
  completedAt?: number;
  prompt: string;
  shortName: string;
  longSummary?: string;
  status: MissionStatus;
  metrics: MissionMetrics;
  filesTouched: string[];
  /** Plain-text summary of the most recent failure inside this mission.
   * Populated server-side from post-tool events with is_error=true.
   * Surfaced in MissionView for failed missions. */
  errorSummary?: string;
  /** Goal this mission rolls up to (Sprint M). */
  goalId?: string;
}

/**
 * A named objective that missions roll up to (Sprint M — "goal
 * constellations"). Planets working toward the same goal are linked by
 * constellation lines in the goal's color.
 */
export interface Goal {
  id: string;
  name: string;
  description?: string;
  /** Hex color used for the constellation lines + chips. */
  color: string;
  createdAt: number;
}

// ── v2 Maestro orchestrator ────────────────────────────────────────────
// A Plan is a high-level goal decomposed into a DAG of PlanTasks. The
// server-side Orchestrator dispatches each ready task to its own worker
// session (planet), verifies the result against acceptance criteria, and
// drives the whole thing A-Z. Distinct from Goal (a flat constellation
// label) and Mission (what one live session is doing right now).

export type PlanStatus =
  | 'draft' // planner is decomposing / not yet presented
  | 'awaiting_approval' // shown to the human, waiting for one-click approve
  | 'running' // approved; dispatching + verifying tasks
  | 'paused' // human paused; no new dispatches
  | 'completed' // every task completed
  | 'failed'; // aborted or a task exhausted retries + escalation

export type PlanTaskStatus =
  | 'pending' // dependencies not yet satisfied
  | 'ready' // dependencies met; eligible to dispatch
  | 'dispatched' // a worker session is executing it
  | 'verifying' // worker stopped; verifier is checking acceptance criteria
  | 'completed' // verified done
  | 'failed' // this attempt failed; orchestrator may retry (attempts < maxAttempts)
  | 'escalated' // failed and out of retries — needs a human (durable, survives restart)
  | 'blocked' // an upstream dependency failed/escalated
  | 'skipped'; // human skipped it

export interface Plan {
  id: string;
  name: string;
  /** The original high-level goal the user handed Maestro. */
  goalPrompt: string;
  status: PlanStatus;
  /** When true, skip the plan-approval gate and dispatch immediately. */
  autoMode: boolean;
  /** Optional constellation grouping this plan's sessions join. */
  goalId?: string;
  /** Default working directory the plan's tasks run in. */
  cwd: string;
  /** Optional plan-wide budget cap (USD) across all tasks. */
  budgetUsd?: number;
  /** Git HEAD of `cwd` captured when the plan started running — the baseline
   *  the review surface diffs against to show everything the fleet changed. */
  baseRef?: string;
  createdAt: number;
  updatedAt: number;
}

/** One file the plan touched, for the review surface. */
export interface PlanReviewFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
}

/** What a plan changed on disk since it started (git diff vs `baseRef`). */
export interface PlanReview {
  ok: boolean;
  error?: string;
  /** True when `cwd` isn't a git repo (nothing to diff). */
  notARepo?: boolean;
  baseRef?: string;
  files: PlanReviewFile[];
  /** Unified diff text (tracked changes + synthesized new-file diffs). */
  diff: string;
  /** True when the diff was capped for size. */
  truncated?: boolean;
}

export interface PlanTask {
  id: string;
  planId: string;
  title: string;
  /** The prompt handed to the worker session. */
  prompt: string;
  /** Human-readable, checkable criteria the verifier accepts the task against. */
  acceptanceCriteria: string;
  status: PlanTaskStatus;
  /** Task ids that must be `completed` before this one dispatches (DAG edges). */
  dependsOn: string[];
  /** Advisor role to dispatch this task as (e.g. 'code-reviewer'). */
  assignedAdvisorRole?: string;
  cwd?: string;
  model?: Model;
  budgetUsd?: number;
  /** Set when dispatched — the worker session executing this task. */
  sessionId?: string;
  /** The worker's mission id. */
  missionId?: string;
  /** Set during verification — the verifier session. */
  verifierSessionId?: string;
  /** Times this task has been dispatched (for bounded retries). */
  attempts: number;
  /** Hard retry ceiling — on the (maxAttempts)th failure the task goes
   * `escalated` (needs a human) instead of retrying. */
  maxAttempts: number;
  /** Why the previous attempt was rejected — fed back into the next attempt's
   *  worker prompt so a retry corrects the specific failure. */
  lastError?: string;
  /** The worker's final output captured when the task completed — injected (as
   *  untrusted context) into dependent tasks' prompts so they know what upstream
   *  work produced, beyond the files on disk. */
  resultSummary?: string;
  /** Stable ordering for display. */
  orderIndex: number;
  createdAt: number;
  updatedAt: number;
}

export type ToolCallStatus = 'running' | 'ok' | 'error';

export interface ToolCall {
  id: string;
  sessionId: string;
  missionId?: string;
  tool: string;
  args: Record<string, unknown>;
  startedAt: number;
  completedAt?: number;
  status: ToolCallStatus;
}

export interface Project {
  id: string;
  cwd: string;
  name: string;
  firstSeenAt: number;
  lastActiveAt: number;
  /** True when the user created this project inside Solix (the build-studio
   *  flow) vs. it being auto-observed from a session's cwd. Managed projects
   *  are durable — Solix owns them and Maestro builds into them. */
  managed?: boolean;
  /** The scaffold template it was created from ('empty' | 'node' | 'web' |
   *  'python'); informs how the preview surface runs it. Managed only. */
  template?: string;
}

export interface ScheduledTask {
  id: string;
  projectId: string;
  /** Working directory the task launches in (Sprint M heartbeats). */
  cwd: string;
  /** Optional short label for the pulsing node in the galaxy. */
  name?: string;
  prompt: string;
  /** Cadence string. Sprint M supports simple intervals: "30m", "2h", "1d".
   * (Full cron is future work — see Sprint M plan.) */
  cron: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt: number;
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  ts: number;
}

export interface ChatDelta {
  messageId: string;
  role: ChatMessage['role'];
  content: string;
  ts: number;
  done: boolean;
}

export interface Advisor {
  id: string;
  role: string;
  codename: string;
  name: string;
  description: string;
  glyph: string;
  color: string;
  defaultModel: Model;
  agentMdPath: string;
  enabled: boolean;
  pinned: boolean;
  pinnedSessionId?: string;
  requiredSkills: string[];
  texturePack?: string;
}

export type SkillSource = 'anthropic' | 'solix' | 'user';

export interface Skill {
  id: string;
  name: string;
  description: string;
  source: SkillSource;
  manifestPath: string;
  installedInProjects: string[];
}

export interface GalaxyManifestAdvisor {
  role: string;
  pinned: boolean;
  model?: Model;
}

export interface GalaxyManifestSkill {
  id: string;
  source: SkillSource;
}

export interface GalaxyManifestProject {
  name: string;
  cwd?: string;
  remoteHint?: string;
}

export interface GalaxyManifestScheduledTask {
  prompt: string;
  cron: string;
}

export interface GalaxyManifest {
  version: 1;
  name: string;
  author?: string;
  description?: string;
  advisors: GalaxyManifestAdvisor[];
  skills: GalaxyManifestSkill[];
  projects: GalaxyManifestProject[];
  scheduledTasks?: GalaxyManifestScheduledTask[];
  theme?: { sunColor?: string; bgColor?: string };
}

/**
 * Timeline events — synthesized from missions/tool_calls/sessions tables on
 * demand for the playback feature. Not persisted as a separate table; the
 * server derives them at query time so we never duplicate state.
 */
export type TimelineEventType =
  | 'session_started'
  | 'session_terminated'
  | 'mission_started'
  | 'mission_completed'
  | 'tool_call';

export interface TimelineEvent {
  ts: number;
  type: TimelineEventType;
  sessionId: string;
  projectId?: string;
  cwd?: string;
  // Per-event payload bits — kept small. The client uses these to update
  // its derived "scene at time T" without round-tripping to the server.
  missionId?: string;
  missionShortName?: string;
  missionPrompt?: string;
  toolName?: string;
  status?: SessionStatus;
}

/**
 * Audit log — append-only history of every privileged action a user took
 * (or the system took on their behalf). Persisted in SQLite under
 * `audit_events`. The Audit tab in GalaxyPanel reads this; downstream
 * exports (CSV / Slack relay) are out of scope for v1 but the shape is
 * stable enough to support them later.
 */
export type AuditKind =
  | 'permission_approved'
  | 'permission_denied'
  | 'advisor_invoked'
  | 'advisor_pinned'
  | 'advisor_unpinned'
  | 'galaxy_imported'
  | 'galaxy_exported'
  | 'galaxy_published'
  | 'skill_installed'
  | 'session_terminated';

export interface AuditEvent {
  id: string;
  ts: number;
  kind: AuditKind;
  sessionId?: string;
  advisorId?: string;
  projectId?: string;
  /** Short human-readable line — e.g. "Approved Bash for demo-c: git push…" */
  summary: string;
  /** Free-form structured detail; kept JSON-string in DB. */
  payload?: Record<string, unknown>;
}

/**
 * Persisted snapshot of a galaxy manifest. Created on every export so the
 * user can browse past states, see what changed between versions, and
 * restore a previous configuration if they want.
 */
export interface GalaxyVersion {
  id: string;
  ts: number;
  /** Sequential index — v1, v2, v3… for human-readable labelling. */
  ordinal: number;
  /** What name was passed at export time. */
  name: string;
  author?: string;
  description?: string;
  /** Full manifest, kept JSON-string in DB. */
  manifest: GalaxyManifest;
}

/**
 * Manifest diff result. Pure function output; consumed by the Versions
 * UI to show "what changed between v3 and v5."
 */
export interface GalaxyManifestDiff {
  advisors: {
    added: string[];
    removed: string[];
    pinChanged: { role: string; from: boolean; to: boolean }[];
  };
  skills: {
    added: string[];
    removed: string[];
  };
  projects: {
    added: string[];
    removed: string[];
  };
}
