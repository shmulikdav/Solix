import type {
  Advisor,
  ChatDelta,
  GalaxyManifest,
  Goal,
  Mission,
  Model,
  Plan,
  PlanTask,
  Project,
  ScheduledTask,
  Session,
  Skill,
  TaskThreadEntry,
  ToolCall,
} from './types.js';

export type ServerMessage =
  | {
      type: 'snapshot';
      projects: Project[];
      sessions: Session[];
      missions: Mission[];
      advisors: Advisor[];
      skills: Skill[];
      schedules: ScheduledTask[];
      goals: Goal[];
      plans: Plan[];
      planTasks: PlanTask[];
    }
  | { type: 'session_upsert'; session: Session }
  | { type: 'session_remove'; sessionId: string }
  | { type: 'mission_upsert'; mission: Mission }
  | { type: 'tool_call'; toolCall: ToolCall }
  | {
      type: 'permission_request';
      sessionId: string;
      tool: string;
      args: Record<string, unknown>;
      requestId: string;
    }
  /**
   * A held tool call is no longer held, and why.
   *
   * Without this the client could only guess. It deleted the decision card
   * the moment it sent `permission_response`, so a response dropped by a
   * closed socket looked exactly like a successful one — the card vanished,
   * the badge cleared, and the agent stayed blocked forever. A second tab
   * kept the card indefinitely with live buttons behind it. And the 300s
   * gate timeout denied with no announcement at all, so five minutes after
   * walking away the agent had been refused and nothing on screen said so.
   *
   * The client removes a card when this arrives, not when it sends.
   */
  | {
      type: 'permission_resolved';
      requestId: string;
      sessionId: string;
      outcome: 'approved' | 'denied' | 'timed_out';
    }
  | { type: 'plan_proposed'; sessionId: string; plan: string }
  | { type: 'chat_delta'; sessionId: string; delta: ChatDelta }
  | { type: 'context_update'; sessionId: string; usagePct: number }
  | {
      type: 'cost_update';
      sessionId: string;
      costUsd: number;
      budgetUsd?: number;
    }
  | {
      type: 'budget_alert';
      sessionId: string;
      costUsd: number;
      budgetUsd: number;
    }
  | {
      type: 'plan_budget_alert';
      planId: string;
      spentUsd: number;
      budgetUsd: number;
      /** Fraction of the cap spent (≈0.8 at the warn threshold). */
      pct: number;
    }
  | { type: 'schedule_upsert'; schedule: ScheduledTask }
  | { type: 'schedule_remove'; scheduleId: string }
  | { type: 'goal_upsert'; goal: Goal }
  | { type: 'goal_remove'; goalId: string }
  | { type: 'project_upsert'; project: Project }
  | { type: 'plan_upsert'; plan: Plan }
  | { type: 'plan_remove'; planId: string }
  | { type: 'plan_task_upsert'; task: PlanTask }
  | { type: 'plan_task_remove'; taskId: string }
  | { type: 'thread_entry_append'; entry: TaskThreadEntry }
  | { type: 'advisor_upsert'; advisor: Advisor }
  | { type: 'skill_upsert'; skill: Skill }
  | { type: 'skill_remove'; skillId: string }
  | { type: 'galaxy_imported'; manifest: GalaxyManifest }
  | {
      type: 'toast';
      level: 'info' | 'warn' | 'error';
      message: string;
    };

export type ClientMessage =
  | { type: 'subscribe_project'; projectId: string }
  | { type: 'send_prompt'; sessionId: string; text: string }
  | { type: 'permission_response'; requestId: string; approved: boolean }
  | {
      type: 'plan_response';
      sessionId: string;
      approved: boolean;
      feedback?: string;
    }
  | {
      type: 'launch_session';
      cwd: string;
      model?: Model;
      initialPrompt?: string;
      /** When set, the server creates a fresh git worktree on this branch
       * (under ~/.solix/worktrees/...) and spawns claude there instead of in
       * `cwd`. Existing branches are reused; new ones branch from
       * `worktreeBaseRef` (defaults to HEAD). */
      worktreeBranch?: string;
      worktreeBaseRef?: string;
      /** Sprint L: when true, dispatch via Anthropic's Agent View
       * (`claude --bg`) so the session becomes a background session
       * managed by the supervisor daemon. Solix's bridge mirrors it
       * back automatically. Requires Claude Code v2.1.139+. */
      useAgentView?: boolean;
      /** Optional subagent name to dispatch (`@code-reviewer ...`). */
      agentName?: string;
      /** Sprint M: optional per-session budget cap (USD). */
      budgetUsd?: number;
      /** Sprint M: goal this task rolls up to (constellation grouping). */
      goalId?: string;
    }
  | { type: 'terminate_session'; sessionId: string }
  | { type: 'raise_budget'; sessionId: string; budgetUsd: number }
  | { type: 'dismiss_budget_alert'; sessionId: string }
  | { type: 'invoke_advisor'; advisorId: string; targetSessionId?: string; prompt?: string }
  | { type: 'pin_advisor'; advisorId: string }
  | { type: 'unpin_advisor'; advisorId: string }
  | { type: 'set_advisor_enabled'; advisorId: string; enabled: boolean };
