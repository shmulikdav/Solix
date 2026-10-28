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

/** Which agent CLI/runtime a session is. Solix is multi-tool: Claude Code by
 *  default, plus Codex (and more later). Drives the planet glyph + pricing. */
export type AgentRuntime = 'claude' | 'codex';

export type SessionKind = 'user' | 'advisor';

/** A session's role when Solix launched it rather than a human.
 *  - worker/verifier/planner: dispatched by the Maestro orchestrator
 *  - routine: fired by a scheduled/webhook/manual routine
 *  Absent for ordinary sessions a human started. Autonomous roles are governed
 *  by the containment denylist instead of a per-step human prompt — there is
 *  nobody at the keyboard to answer one. */
export type SessionRole = 'worker' | 'verifier' | 'planner' | 'routine';

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
  /** The agent runtime behind this session ('claude' default, 'codex', …). */
  runtime?: AgentRuntime;
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

/** A tenant (P3 #10). A default org always exists; a Team edition can add more
 *  to isolate plans and goals. */
export interface Org {
  id: string;
  name: string;
  createdAt: number;
}

/** What storage backend is active + what's configured (P3 #10). SQLite is the
 *  implemented driver; Postgres/S3 are config-gated adapters. */
export interface StorageStatus {
  /** The driver actually serving reads/writes right now. */
  active: 'sqlite';
  /** A Postgres target is configured via SOLIX_PG_URL (adapter pending). */
  postgresConfigured: boolean;
  /** An S3 artifact target is configured via SOLIX_S3_BUCKET (adapter pending). */
  s3Configured: boolean;
  /** Human-readable note about the backend seam. */
  note: string;
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
  /** Owning org/tenant (P3 #10). Absent → the default org. */
  orgId?: string;
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
  /** Owning org/tenant (P3 #10). Absent → the default org. */
  orgId?: string;
  /** Default working directory the plan's tasks run in. */
  cwd: string;
  /** Optional plan-wide budget cap (USD) across all tasks. */
  budgetUsd?: number;
  /** Git HEAD of `cwd` captured when the plan started running — the baseline
   *  the review surface diffs against to show everything the fleet changed. */
  baseRef?: string;
  /** True once the soft budget heads-up has fired (~80% of the cap), so it
   *  only warns once before the hard pause at 100% (P2 #6). */
  budgetWarned?: boolean;
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
  /**
   * The ref actually diffed against.
   *
   * **Undefined means it fell back to `HEAD`**, which is not a plan-scoped
   * comparison at all — it is the working tree, including whatever the user
   * has been editing themselves. The client must say so rather than
   * presenting it under "what did the fleet change?". This was returned and
   * never read.
   */
  baseRef?: string;
  /**
   * The base the plan recorded, when one existed but could not be used —
   * a deleted branch, a rewritten history. Present only in that case, so
   * the client can distinguish "this plan never got a base" from "its base
   * is gone", which are different kinds of wrong.
   */
  requestedBaseRef?: string;
  /** Untracked files beyond the scan cap, not represented in `files`. */
  untrackedOmitted?: number;
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
  /** Which agent runtime runs this task's worker ('claude' default, 'codex'). */
  runtime?: AgentRuntime;
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
  /** How many delegation hops produced this task (0 = from the original plan).
   *  A worker may propose subtasks (P2 #8); each inherits parent depth + 1, and
   *  the orchestrator refuses to expand past a hard depth cap. */
  delegationDepth?: number;
  createdAt: number;
  updatedAt: number;
}

// ── Task threads (P1) ──────────────────────────────────────────────────
// Each PlanTask carries a thread: a chronological timeline of what happened
// to it (dispatched, worker result, verifier verdict, retry/escalation
// reasons) interleaved with human comments. It turns a task from a status
// chip into a trackable unit with a full run history + conversation.

/** Who authored a task-thread entry. */
export type ThreadAuthor = 'system' | 'worker' | 'verifier' | 'human';

/**
 * Kind of task-thread entry. Open enum (rendered by category) — the server
 * may add new kinds without a protocol bump, mirroring the status columns.
 *  - dispatched: a worker attempt started
 *  - worker_result: the worker finished (body = result summary)
 *  - completed: the verifier accepted the task
 *  - retry: an attempt was rejected and will be retried (body = reason)
 *  - escalated: retries exhausted — needs a human (body = reason)
 *  - aborted: an operator stopped the run
 *  - comment: a human note on the task
 *  - follow_up: a human comment promoted into a follow-up task (P1 #4)
 */
export type ThreadEntryKind =
  | 'dispatched'
  | 'worker_result'
  | 'completed'
  | 'retry'
  | 'escalated'
  | 'aborted'
  | 'comment'
  | 'follow_up'
  | string;

export interface TaskThreadEntry {
  id: string;
  taskId: string;
  planId: string;
  kind: ThreadEntryKind;
  author: ThreadAuthor;
  /** Free text / markdown. Worker and verifier bodies are untrusted output. */
  body: string;
  /** Which task attempt this entry belongs to, when it came from a dispatch. */
  attempt?: number;
  /** Optional structured extras (e.g. { sessionId, costUsd, followUpTaskId }). */
  payload?: Record<string, unknown>;
  createdAt: number;
}

/** A managed integration (API key bundle, or later an MCP server) that workers
 *  can be granted scoped access to. Secret VALUES are never carried in this
 *  shape — only the key names, for display. */
export type ConnectionKind = 'env' | 'mcp';

export interface Connection {
  id: string;
  name: string;
  kind: ConnectionKind;
  createdAt: number;
  /** The secret key NAMES stored for this connection (values never exposed). */
  secretKeys: string[];
  /** Who may use it: advisor roles, plan ids, or '*' for every worker. */
  grants: string[];
}

// ── Chat notifiers (P3 #11) ────────────────────────────────────────────
// A destination Solix posts fleet events to (Slack incoming webhook or a
// Telegram bot). The provider credentials are encrypted at rest and never
// returned over the API — only the non-secret shape is exposed.

export type NotifierProvider = 'slack' | 'telegram';

/** Fleet events a notifier can subscribe to. */
export type NotifyEvent =
  | 'plan_completed'
  | 'plan_failed'
  | 'task_escalated'
  | 'budget_alert';

export interface Notifier {
  id: string;
  provider: NotifierProvider;
  name: string;
  /** Which events this destination receives. */
  events: NotifyEvent[];
  enabled: boolean;
  createdAt: number;
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

/** How a routine fires (P1 #5):
 *  - interval: on a cadence (the heartbeat scheduler ticks it)
 *  - webhook: on an inbound POST to its capability URL (token-authenticated)
 *  - manual: fire-only, run on demand from the UI/API */
export type TriggerKind = 'interval' | 'webhook' | 'manual';

export interface ScheduledTask {
  id: string;
  projectId: string;
  /** Working directory the task launches in (Sprint M heartbeats). */
  cwd: string;
  /** Optional short label for the pulsing node in the galaxy. */
  name?: string;
  prompt: string;
  /** Cadence string. Sprint M supports simple intervals: "30m", "2h", "1d".
   * (Full cron is future work — see Sprint M plan.) Ignored for non-interval
   * triggers. */
  cron: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt: number;
  /** How this routine fires (default 'interval'). */
  trigger?: TriggerKind;
  /** Optional owner label (an advisor role, a person, a team). */
  owner?: string;
  /** Capability token for a webhook trigger — the secret in its fire URL
   *  (POST /api/triggers/:token). Local-only; shown so the UI can build the
   *  URL. Absent for interval/manual triggers. */
  webhookToken?: string;
}

/** One recorded firing of a routine (P1 #5 run history). */
export interface ScheduleRun {
  id: string;
  scheduleId: string;
  /** Which trigger caused this run. */
  trigger: TriggerKind | string;
  /** Outcome: 'fired' (launched), 'skipped' (e.g. disabled), 'error'. */
  status: 'fired' | 'skipped' | 'error' | string;
  /** Short human-readable detail (prompt snippet, or an error message). */
  detail?: string;
  firedAt: number;
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

// ── Team templates (P2 #7) ─────────────────────────────────────────────
// A curated, installable bundle of advisors + skills + routines for a goal,
// so a user can stand up a ready-made "team" in one click. Built on the same
// building blocks as galaxy import/export.

export interface TeamTemplateRoutine {
  name: string;
  prompt: string;
  /** Trigger kind for the routine (default 'interval'). */
  trigger?: TriggerKind;
  /** Cadence for interval routines (e.g. '1d'). Ignored otherwise. */
  cadence?: string;
}

export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  /** The kind of goal this team is for — shown as the tagline. */
  goal: string;
  /** Advisor ids this team enables (e.g. 'forge', 'argus'). */
  advisors: string[];
  /** Skill ids/names this team installs into the target project. */
  skills: string[];
  /** Routines this team sets up in the target project. */
  routines: TeamTemplateRoutine[];
}

/** What a team-template install actually applied (missing pieces → warnings). */
export interface TeamInstallResult {
  ok: boolean;
  templateId: string;
  advisorsEnabled: string[];
  skillsInstalled: string[];
  routinesCreated: string[];
  warnings: string[];
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
  // Refused by containment before any human saw it. Distinct from
  // `permission_denied`, which means a person looked at it and said no —
  // conflating the two makes it impossible to say how much the denylist
  // caught on its own, which is the number worth reporting.
  | 'command_blocked'
  // A plan stopped itself at its budget ceiling.
  | 'budget_paused'
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
