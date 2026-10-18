import { create } from 'zustand';
import type {
  Advisor,
  ChatDelta,
  ClientMessage,
  Goal,
  Mission,
  Org,
  Plan,
  PlanTask,
  Project,
  ScheduledTask,
  ScheduleRun,
  ServerMessage,
  Session,
  Skill,
  TaskThreadEntry,
  TimelineEvent,
  ToolCall,
  TriggerKind,
} from '@solix/shared';
import { chime, notify } from '../notifications.js';
import { RIGHT_DOCK_WIDTH_PX, type PanelId } from '../panels/dock.js';
import { RAIL_WIDTH_PX } from '../shell/surfaces.js';

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  receivedAt: number;
}

export interface RecentToolCall extends ToolCall {
  receivedAt: number;
}

export interface ChatEntry extends ChatDelta {
  receivedAt: number;
}

export interface BudgetAlert {
  sessionId: string;
  costUsd: number;
  budgetUsd: number;
  receivedAt: number;
}

export interface PlanBudgetAlert {
  planId: string;
  spentUsd: number;
  budgetUsd: number;
  pct: number;
  receivedAt: number;
}

/**
 * Playback / time-scrubbing state.
 *
 * When `active` is true:
 *   - the `<Scene>` and `<ListView>` read from `derivedSessions` /
 *     `derivedMissions` / `derivedToolCalls` instead of the live state
 *   - incoming WS messages still update the *live* state but the visible
 *     state is what we derive from `events` up to `currentMs`
 *
 * `events` is the timeline returned by GET /api/timeline. We derive the
 * scene-at-time-T client side so scrubbing the slider is instantaneous.
 */
export interface PlaybackState {
  active: boolean;
  loading: boolean;
  events: TimelineEvent[];
  earliestMs: number;
  latestMs: number;
  currentMs: number;
  playing: boolean;
  speed: number; // 1 = real-time replay; 4 = 4x; 16 = 16x
  derivedSessions: Record<string, Session>;
  derivedMissions: Record<string, Mission>;
  derivedToolCalls: RecentToolCall[];
}

/**
 * Replay events up to time T to compute "what the scene looked like at T."
 *
 * Cheap to call — O(events) — and called only on user-driven scrub events
 * or once per RAF frame while playing back. We pull live session/mission
 * records as the source of truth for static metadata (cwd, model, projectId,
 * shortName) and just toggle in/out their existence + status based on the
 * event stream.
 */
function derivePlaybackSnapshot(
  events: TimelineEvent[],
  currentMs: number,
  liveSessions: Record<string, Session>,
  liveMissions: Record<string, Mission>,
): {
  derivedSessions: Record<string, Session>;
  derivedMissions: Record<string, Mission>;
  derivedToolCalls: RecentToolCall[];
} {
  const sessions: Record<string, Session> = {};
  const missions: Record<string, Mission> = {};
  // Comet streaks during playback: only those within the last ~2s of
  // virtual time, so the visual matches live-mode TTL.
  const COMET_TTL_MS = 2000;
  const tools: RecentToolCall[] = [];

  for (const e of events) {
    if (e.ts > currentMs) break;
    switch (e.type) {
      case 'session_started': {
        const live = liveSessions[e.sessionId];
        if (!live) continue;
        sessions[e.sessionId] = { ...live, status: 'idle' };
        break;
      }
      case 'session_terminated': {
        delete sessions[e.sessionId];
        break;
      }
      case 'mission_started': {
        if (!e.missionId) continue;
        const liveMission = liveMissions[e.missionId];
        const session = sessions[e.sessionId];
        if (session) {
          sessions[e.sessionId] = {
            ...session,
            status: 'active',
            currentMissionId: e.missionId,
          };
        }
        if (liveMission) {
          missions[e.missionId] = { ...liveMission, status: 'active' };
        }
        break;
      }
      case 'mission_completed': {
        if (!e.missionId) continue;
        const session = sessions[e.sessionId];
        const liveMission = liveMissions[e.missionId];
        if (session && session.currentMissionId === e.missionId) {
          sessions[e.sessionId] = {
            ...session,
            status: 'idle',
            currentMissionId: undefined,
            lastCompletedMissionId: e.missionId,
          };
        }
        if (liveMission) {
          missions[e.missionId] = { ...liveMission, status: 'completed' };
        }
        break;
      }
      case 'tool_call': {
        // Carry the tool call only if it's within the visible TTL window.
        if (currentMs - e.ts <= COMET_TTL_MS) {
          tools.push({
            id: `tc-${e.ts}-${e.sessionId}`,
            sessionId: e.sessionId,
            tool: e.toolName ?? 'tool',
            args: {},
            startedAt: e.ts,
            status: 'ok',
            receivedAt: e.ts,
          });
        }
        break;
      }
    }
  }

  return {
    derivedSessions: sessions,
    derivedMissions: missions,
    derivedToolCalls: tools,
  };
}

const EMPTY_PLAYBACK: PlaybackState = {
  active: false,
  loading: false,
  events: [],
  earliestMs: 0,
  latestMs: 0,
  currentMs: 0,
  playing: false,
  speed: 4,
  derivedSessions: {},
  derivedMissions: {},
  derivedToolCalls: [],
};

interface SolixState {
  connected: boolean;
  projects: Record<string, Project>;
  sessions: Record<string, Session>;
  missions: Record<string, Mission>;
  advisors: Record<string, Advisor>;
  skills: Record<string, Skill>;
  schedules: Record<string, ScheduledTask>;
  goals: Record<string, Goal>;
  plans: Record<string, Plan>;
  planTasks: Record<string, PlanTask>;
  /** Orgs/tenants (P3 #10) + the active one. Loaded over HTTP, not the WS. */
  orgs: Org[];
  currentOrgId: string;
  /** Per-task thread (P1): lifecycle timeline + human comments, keyed by task
   *  id. Lazily loaded when a task is expanded; live-appended over the WS. */
  threadsByTaskId: Record<string, TaskThreadEntry[]>;
  budgetAlerts: Record<string, BudgetAlert>;
  /** Soft budget heads-ups (~80% of a plan cap), keyed by plan id (P2 #6). */
  planBudgetAlerts: Record<string, PlanBudgetAlert>;
  recentToolCalls: RecentToolCall[];
  pendingPermissions: Record<string, PendingPermission>;
  // Per-session chat log, in arrival order. Capped at 200 entries per session.
  chatBySessionId: Record<string, ChatEntry[]>;
  /** The single open right-dock panel, or null. Source of dock exclusivity. */
  activePanel: PanelId | null;
  /** Remembered tab for a tabbed panel, so reopening returns you where you were. */
  activePanelTab: string | null;
  selectedSessionId: string | null;
  selectedAdvisorId: string | null;
  selectedSkillId: string | null;
  motionEnabled: boolean;
  viewMode: 'galaxy' | 'list' | 'missions';
  playback: PlaybackState;
  toasts: { id: string; level: 'info' | 'warn' | 'error'; message: string }[];

  setConnected: (c: boolean) => void;
  applyMessage: (msg: ServerMessage) => void;
  openPanel: (id: PanelId, tab?: string) => void;
  closePanel: () => void;
  selectSession: (id: string | null) => void;
  selectAdvisor: (id: string | null) => void;
  selectSkill: (id: string | null) => void;
  openWorkspace: () => void;
  closeWorkspace: () => void;
  openPlanPanel: () => void;
  closePlanPanel: () => void;
  /** v2 Maestro — POST a goal to the orchestrator; returns the created plan id
   *  (draft → awaiting_approval) or validation errors. */
  createPlanFromGoal: (
    goal: string,
    cwd: string,
    opts?: {
      name?: string;
      autoMode?: boolean;
      goalId?: string;
      budgetUsd?: number;
    },
  ) => Promise<{
    ok: boolean;
    planId?: string;
    errors?: string[];
    warnings?: string[];
  }>;
  approvePlan: (
    planId: string,
  ) => Promise<{ ok: boolean; error?: string; upsell?: boolean }>;
  abortPlan: (planId: string) => Promise<void>;
  resumePlan: (
    planId: string,
  ) => Promise<{ ok: boolean; error?: string; upsell?: boolean }>;
  /** Load a task's thread (GET) into the store — call when a task is expanded. */
  fetchTaskThread: (planId: string, taskId: string) => Promise<void>;
  /** Append a human comment to a task's thread (POST). */
  postTaskComment: (
    planId: string,
    taskId: string,
    body: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Comment-on-passage → follow-up task (POST). A review comment on a file/diff
   *  becomes a new worker task on the plan, re-running it. */
  addFollowUp: (
    planId: string,
    input: { body: string; file?: string; hunk?: string; sourceTaskId?: string },
  ) => Promise<{ ok: boolean; taskId?: string; upsell?: boolean; error?: string }>;
  activateLicense: (
    key: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Orgs/tenancy (P3 #10). */
  loadOrgs: () => Promise<void>;
  createOrg: (name: string) => Promise<{ ok: boolean; error?: string }>;
  setCurrentOrg: (orgId: string) => Promise<void>;
  deleteOrg: (orgId: string) => Promise<{ ok: boolean; error?: string }>;
  /** Install a ready-made team template (advisors+skills+routines) into a
   *  project (P2 #7). */
  /** Routines (scheduled tasks). Every mutating route broadcasts over the
   *  websocket, so none of these write optimistically — they POST and let the
   *  snapshot land. There is deliberately no edit action: the server has no
   *  PATCH /api/schedules/:id, and delete-and-recreate is not a substitute
   *  because it drops run history and rotates the webhook token, which would
   *  silently break any webhook already wired up. */
  loadSchedules: () => Promise<void>;
  createSchedule: (input: {
    cwd: string;
    prompt: string;
    cadence?: string;
    name?: string;
    trigger?: TriggerKind;
    owner?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
  setScheduleEnabled: (id: string, enabled: boolean) => Promise<void>;
  deleteSchedule: (id: string) => Promise<void>;
  fireSchedule: (id: string) => Promise<{ ok: boolean; error?: string }>;
  loadScheduleRuns: (id: string) => Promise<ScheduleRun[]>;

  installTeamTemplate: (
    templateId: string,
    cwd: string,
    includeRoutines?: boolean,
  ) => Promise<{ ok: boolean; warnings?: string[]; error?: string }>;
  /** Skill authoring (P3 #9). */
  createSkill: (input: {
    name: string;
    description?: string;
    body: string;
  }) => Promise<{ ok: boolean; id?: string; error?: string }>;
  updateSkill: (
    id: string,
    patch: { name?: string; description?: string; body?: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  deleteSkill: (id: string) => Promise<{ ok: boolean; error?: string }>;
  restoreSkillVersion: (
    id: string,
    versionId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  createProject: (
    name: string,
    opts?: { path?: string; template?: string },
  ) => Promise<{ ok: boolean; project?: Project; error?: string }>;
  dismissToast: (id: string) => void;
  resolvePermission: (requestId: string, approved: boolean) => void;
  invokeAdvisor: (advisorId: string, prompt?: string) => void;
  pinAdvisor: (advisorId: string) => void;
  unpinAdvisor: (advisorId: string) => void;
  enableAdvisor: (advisorId: string) => void;
  disableAdvisor: (advisorId: string) => void;
  sendPromptTo: (sessionId: string, text: string) => void;
  launchTask: (
    cwd: string,
    model: string,
    initialPrompt?: string,
    opts?: {
      worktreeBranch?: string;
      worktreeBaseRef?: string;
      useAgentView?: boolean;
      agentName?: string;
      budgetUsd?: number;
      goalId?: string;
    },
  ) => void;
  raiseBudget: (sessionId: string, budgetUsd: number) => void;
  dismissBudgetAlert: (sessionId: string) => void;
  selectedSessionIds: Set<string>;
  toggleSessionSelection: (id: string) => void;
  clearSessionSelection: () => void;
  terminateSessions: (ids: string[]) => void;
  setMotionEnabled: (b: boolean) => void;
  toggleMotion: () => void;
  setViewMode: (m: 'galaxy' | 'list' | 'missions') => void;
  toggleViewMode: () => void;
  enterPlayback: (events: TimelineEvent[], earliestMs: number, latestMs: number) => void;
  exitPlayback: () => void;
  setPlaybackTime: (ms: number) => void;
  setPlaybackSpeed: (speed: number) => void;
  setPlaybackPlaying: (playing: boolean) => void;
  setPlaybackLoading: (loading: boolean) => void;

  send: (msg: ClientMessage) => void;
  attachSocket: (send: (msg: ClientMessage) => void) => void;
}

const TOOL_CALL_TTL_MS = 2000;

const MOTION_KEY = 'solix.motion.v1';
const VIEW_KEY = 'solix.viewMode.v1';

function readMotionPref(): boolean {
  try {
    const v = localStorage.getItem(MOTION_KEY);
    return v === '1';
  } catch {
    return false;
  }
}

function writeMotionPref(b: boolean): void {
  try {
    localStorage.setItem(MOTION_KEY, b ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function readViewPref(): 'galaxy' | 'list' | 'missions' {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'list' || v === 'missions' || v === 'galaxy') return v;
    return 'galaxy';
  } catch {
    return 'galaxy';
  }
}

function writeViewPref(m: 'galaxy' | 'list' | 'missions'): void {
  try {
    localStorage.setItem(VIEW_KEY, m);
  } catch {
    /* ignore */
  }
}

/**
 * The one place dock exclusivity is expressed: set the active panel and clear
 * every selection, then apply whichever selection belongs to the new panel.
 * Returning a partial keeps all callers a single `set(...)`.
 */
function panelPatch(
  next: PanelId | null,
  ids: Partial<
    Pick<
      SolixState,
      'selectedSessionId' | 'selectedAdvisorId' | 'selectedSkillId'
    >
  >,
  tab?: string,
): Partial<SolixState> {
  return {
    activePanel: next,
    activePanelTab: tab ?? null,
    selectedSessionId: null,
    selectedAdvisorId: null,
    selectedSkillId: null,
    ...ids,
  };
}

export const useSolixStore = create<SolixState>((set, get) => ({
  connected: false,
  projects: {},
  sessions: {},
  missions: {},
  advisors: {},
  skills: {},
  schedules: {},
  goals: {},
  plans: {},
  planTasks: {},
  orgs: [],
  currentOrgId: 'org-default',
  threadsByTaskId: {},
  budgetAlerts: {},
  planBudgetAlerts: {},
  chatBySessionId: {},
  recentToolCalls: [],
  pendingPermissions: {},
  activePanel: null,
  activePanelTab: null,
  selectedSessionId: null,
  selectedAdvisorId: null,
  selectedSkillId: null,
  motionEnabled: readMotionPref(),
  viewMode: readViewPref(),
  playback: EMPTY_PLAYBACK,
  toasts: [],

  setConnected: (connected) => set({ connected }),

  applyMessage: (msg) => {
    switch (msg.type) {
      case 'snapshot': {
        const projects: Record<string, Project> = {};
        for (const p of msg.projects) projects[p.id] = p;
        const sessions: Record<string, Session> = {};
        for (const s of msg.sessions) sessions[s.id] = s;
        const missions: Record<string, Mission> = {};
        for (const m of msg.missions) missions[m.id] = m;
        const advisors: Record<string, Advisor> = {};
        for (const a of msg.advisors) advisors[a.id] = a;
        const skills: Record<string, Skill> = {};
        for (const sk of msg.skills) skills[sk.id] = sk;
        const schedules: Record<string, ScheduledTask> = {};
        for (const sc of msg.schedules) schedules[sc.id] = sc;
        const goals: Record<string, Goal> = {};
        for (const g of msg.goals) goals[g.id] = g;
        const plans: Record<string, Plan> = {};
        for (const pl of msg.plans) plans[pl.id] = pl;
        const planTasks: Record<string, PlanTask> = {};
        for (const t of msg.planTasks) planTasks[t.id] = t;
        set({
          projects,
          sessions,
          missions,
          advisors,
          skills,
          schedules,
          goals,
          plans,
          planTasks,
        });
        break;
      }
      case 'advisor_upsert': {
        set((s) => ({
          advisors: { ...s.advisors, [msg.advisor.id]: msg.advisor },
        }));
        break;
      }
      case 'skill_upsert': {
        set((s) => ({
          skills: { ...s.skills, [msg.skill.id]: msg.skill },
        }));
        break;
      }
      case 'skill_remove': {
        set((s) => {
          const next = { ...s.skills };
          delete next[msg.skillId];
          return { skills: next };
        });
        break;
      }
      case 'galaxy_imported': {
        // Snapshot will follow; no-op for now beyond toast.
        const id = `${Date.now()}-galaxy`;
        set((s) => ({
          toasts: [
            ...s.toasts,
            {
              id,
              level: 'info' as const,
              message: `Imported galaxy: ${msg.manifest.name}`,
            },
          ].slice(-6),
        }));
        setTimeout(() => get().dismissToast(id), 5000);
        break;
      }
      case 'session_upsert': {
        set((s) => ({
          sessions: { ...s.sessions, [msg.session.id]: msg.session },
        }));
        break;
      }
      case 'session_remove': {
        set((s) => {
          const next = { ...s.sessions };
          delete next[msg.sessionId];
          return { sessions: next };
        });
        break;
      }
      case 'mission_upsert': {
        set((s) => ({
          missions: { ...s.missions, [msg.mission.id]: msg.mission },
        }));
        break;
      }
      case 'tool_call': {
        const enriched: RecentToolCall = {
          ...msg.toolCall,
          receivedAt: Date.now(),
        };
        set((s) => ({
          recentToolCalls: [...s.recentToolCalls, enriched].slice(-200),
        }));
        // GC old comets
        setTimeout(() => {
          set((s) => ({
            recentToolCalls: s.recentToolCalls.filter(
              (t) => Date.now() - t.receivedAt < TOOL_CALL_TTL_MS,
            ),
          }));
        }, TOOL_CALL_TTL_MS + 50);
        break;
      }
      case 'permission_request': {
        const p: PendingPermission = {
          requestId: msg.requestId,
          sessionId: msg.sessionId,
          tool: msg.tool,
          args: msg.args,
          receivedAt: Date.now(),
        };
        set((s) => ({
          pendingPermissions: {
            ...s.pendingPermissions,
            [msg.requestId]: p,
          },
        }));
        // Background notification + chime so the user catches this when
        // the tab isn't focused. Both are no-ops when permissions / prefs
        // aren't granted.
        const session = get().sessions[msg.sessionId];
        const name = session?.name ?? msg.sessionId.slice(0, 8);
        const argSummary = (() => {
          const k = Object.keys(msg.args)[0];
          if (!k) return '';
          const v = msg.args[k];
          const s = typeof v === 'string' ? v : JSON.stringify(v);
          return `: ${s.length > 60 ? s.slice(0, 60) + '…' : s}`;
        })();
        void notify({
          title: `${name} needs you`,
          body: `${msg.tool}${argSummary}`,
          tag: `solix-perm-${msg.sessionId}`,
          whenHidden: true,
        });
        chime();
        break;
      }
      case 'context_update': {
        set((s) => {
          const session = s.sessions[msg.sessionId];
          if (!session) return s;
          return {
            sessions: {
              ...s.sessions,
              [msg.sessionId]: {
                ...session,
                contextUsagePct: msg.usagePct,
              },
            },
          };
        });
        break;
      }
      case 'cost_update': {
        set((s) => {
          const session = s.sessions[msg.sessionId];
          if (!session) return s;
          return {
            sessions: {
              ...s.sessions,
              [msg.sessionId]: {
                ...session,
                costUsd: msg.costUsd,
                budgetUsd: msg.budgetUsd ?? session.budgetUsd,
              },
            },
          };
        });
        break;
      }
      case 'budget_alert': {
        const alert: BudgetAlert = {
          sessionId: msg.sessionId,
          costUsd: msg.costUsd,
          budgetUsd: msg.budgetUsd,
          receivedAt: Date.now(),
        };
        set((s) => ({
          budgetAlerts: { ...s.budgetAlerts, [msg.sessionId]: alert },
        }));
        const session = get().sessions[msg.sessionId];
        void notify({
          title: `${session?.name ?? msg.sessionId.slice(0, 8)} hit its budget`,
          body: `$${msg.costUsd.toFixed(2)} / $${msg.budgetUsd.toFixed(2)}`,
          tag: `solix-budget-${msg.sessionId}`,
          whenHidden: true,
        });
        chime();
        break;
      }
      case 'plan_budget_alert': {
        const alert: PlanBudgetAlert = {
          planId: msg.planId,
          spentUsd: msg.spentUsd,
          budgetUsd: msg.budgetUsd,
          pct: msg.pct,
          receivedAt: Date.now(),
        };
        set((s) => ({
          planBudgetAlerts: { ...s.planBudgetAlerts, [msg.planId]: alert },
        }));
        const plan = get().plans[msg.planId];
        void notify({
          title: `${plan?.name ?? 'A plan'} is nearing its budget`,
          body: `$${msg.spentUsd.toFixed(2)} / $${msg.budgetUsd.toFixed(2)} (${Math.round(msg.pct * 100)}%)`,
          tag: `solix-plan-budget-${msg.planId}`,
          whenHidden: true,
        });
        break;
      }
      case 'schedule_upsert': {
        set((s) => ({
          schedules: { ...s.schedules, [msg.schedule.id]: msg.schedule },
        }));
        break;
      }
      case 'schedule_remove': {
        set((s) => {
          const next = { ...s.schedules };
          delete next[msg.scheduleId];
          return { schedules: next };
        });
        break;
      }
      case 'goal_upsert': {
        set((s) => ({ goals: { ...s.goals, [msg.goal.id]: msg.goal } }));
        break;
      }
      case 'goal_remove': {
        set((s) => {
          const next = { ...s.goals };
          delete next[msg.goalId];
          return { goals: next };
        });
        break;
      }
      case 'project_upsert': {
        set((s) => ({
          projects: { ...s.projects, [msg.project.id]: msg.project },
        }));
        break;
      }
      case 'plan_upsert': {
        set((s) => ({ plans: { ...s.plans, [msg.plan.id]: msg.plan } }));
        break;
      }
      case 'plan_remove': {
        set((s) => {
          const nextPlans = { ...s.plans };
          delete nextPlans[msg.planId];
          // Drop the plan's tasks (and their threads) too so nothing dangles.
          const nextTasks: Record<string, PlanTask> = {};
          const nextThreads = { ...s.threadsByTaskId };
          for (const [id, t] of Object.entries(s.planTasks)) {
            if (t.planId !== msg.planId) nextTasks[id] = t;
            else delete nextThreads[id];
          }
          const nextPlanAlerts = { ...s.planBudgetAlerts };
          delete nextPlanAlerts[msg.planId];
          return {
            plans: nextPlans,
            planTasks: nextTasks,
            threadsByTaskId: nextThreads,
            planBudgetAlerts: nextPlanAlerts,
          };
        });
        break;
      }
      case 'plan_task_upsert': {
        set((s) => ({
          planTasks: { ...s.planTasks, [msg.task.id]: msg.task },
        }));
        break;
      }
      case 'plan_task_remove': {
        set((s) => {
          const next = { ...s.planTasks };
          delete next[msg.taskId];
          const threads = { ...s.threadsByTaskId };
          delete threads[msg.taskId];
          return { planTasks: next, threadsByTaskId: threads };
        });
        break;
      }
      case 'thread_entry_append': {
        set((s) => {
          const existing = s.threadsByTaskId[msg.entry.taskId] ?? [];
          // De-dupe by id so an optimistic POST result + its WS echo don't double.
          if (existing.some((e) => e.id === msg.entry.id)) return s;
          return {
            threadsByTaskId: {
              ...s.threadsByTaskId,
              [msg.entry.taskId]: [...existing, msg.entry],
            },
          };
        });
        break;
      }
      case 'chat_delta': {
        const entry: ChatEntry = { ...msg.delta, receivedAt: Date.now() };
        set((s) => {
          const existing = s.chatBySessionId[msg.sessionId] ?? [];
          // De-dupe by messageId so retries from the watcher don't double up.
          const deduped = existing.filter(
            (e) => e.messageId !== entry.messageId,
          );
          const next = [...deduped, entry].slice(-200);
          return {
            chatBySessionId: {
              ...s.chatBySessionId,
              [msg.sessionId]: next,
            },
          };
        });
        break;
      }
      case 'toast': {
        const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        set((s) => ({
          toasts: [
            ...s.toasts,
            { id, level: msg.level, message: msg.message },
          ].slice(-6),
        }));
        setTimeout(() => get().dismissToast(id), 5000);
        break;
      }
      default:
        break;
    }
  },

  // ── Right dock ────────────────────────────────────────────────────
  // `activePanel` is the single source of dock exclusivity. The three
  // selection ids are kept as denormalised projections of it rather than
  // folded into a discriminated union: they're read in ~15 places including
  // hot react-three-fiber render paths and ClickRipple's store.subscribe, and
  // collapsing them would force every one of those to re-derive.

  openPanel: (id, tab) => set(panelPatch(id, {}, tab)),

  closePanel: () => set(panelPatch(null, {})),

  selectSession: (id) =>
    set((s) =>
      id
        ? panelPatch('session', { selectedSessionId: id })
        : // Clearing a selection that isn't on screen must stay a no-op —
          // previously `selectSession(null)` deliberately left the workspace
          // and plan panels open, and widening that would close panels the
          // user never asked to close.
          s.activePanel === 'session'
          ? panelPatch(null, {})
          : {},
    ),

  selectAdvisor: (id) =>
    set((s) =>
      id
        ? panelPatch('advisor', { selectedAdvisorId: id })
        : s.activePanel === 'advisor'
          ? panelPatch(null, {})
          : {},
    ),

  selectSkill: (id) =>
    set((s) =>
      id
        ? panelPatch('skill', { selectedSkillId: id })
        : s.activePanel === 'skill'
          ? panelPatch(null, {})
          : {},
    ),

  // Kept as thin aliases so the 3D scene (Sun.tsx, Scene.tsx) and the keymap
  // don't change in this phase. Removed in the cleanup phase.
  openWorkspace: () => set(panelPatch('workspace', {})),
  closeWorkspace: () =>
    set((s) => (s.activePanel === 'workspace' ? panelPatch(null, {}) : {})),
  openPlanPanel: () => set(panelPatch('plan', {})),
  closePlanPanel: () =>
    set((s) => (s.activePanel === 'plan' ? panelPatch(null, {}) : {})),

  createPlanFromGoal: async (goal, cwd, opts) => {
    try {
      const res = await fetch('/api/plans/from-goal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goal, cwd, ...opts }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        planId?: string;
        errors?: string[];
        warnings?: string[];
      };
      return {
        ok: Boolean(data.ok),
        planId: data.planId,
        errors: data.errors,
        warnings: data.warnings,
      };
    } catch (err) {
      return { ok: false, errors: [(err as Error).message] };
    }
  },

  approvePlan: async (planId) => {
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(planId)}/approve`,
        { method: 'POST' },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        upsell?: boolean;
      };
      return { ok: Boolean(data.ok), error: data.error, upsell: data.upsell };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  resumePlan: async (planId) => {
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(planId)}/resume`,
        { method: 'POST' },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        upsell?: boolean;
      };
      return { ok: Boolean(data.ok), error: data.error, upsell: data.upsell };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  loadOrgs: async () => {
    try {
      const res = await fetch('/api/orgs');
      const data = (await res.json()) as { orgs: Org[]; currentOrgId: string };
      set({ orgs: data.orgs ?? [], currentOrgId: data.currentOrgId ?? 'org-default' });
    } catch {
      /* offline */
    }
  },

  createOrg: async (name) => {
    if (!name.trim()) return { ok: false, error: 'Name is empty.' };
    try {
      const res = await fetch('/api/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) return { ok: false, error: 'Create failed.' };
      await get().loadOrgs();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  setCurrentOrg: async (orgId) => {
    // Optimistic — the server persists it; reload to confirm.
    set({ currentOrgId: orgId });
    try {
      await fetch('/api/orgs/current', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId }),
      });
    } catch {
      /* offline; the optimistic value stands for this session */
    }
  },

  deleteOrg: async (orgId) => {
    try {
      const res = await fetch(`/api/orgs/${encodeURIComponent(orgId)}`, {
        method: 'DELETE',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return { ok: false, error: data.error ?? 'Delete failed.' };
      await get().loadOrgs();
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  loadSchedules: async () => {
    try {
      const res = await fetch('/api/schedules');
      const list = (await res.json()) as ScheduledTask[];
      if (!Array.isArray(list)) return;
      const next: Record<string, ScheduledTask> = {};
      for (const sc of list) next[sc.id] = sc;
      set({ schedules: next });
    } catch {
      /* server not reachable — the websocket snapshot is the primary path */
    }
  },

  createSchedule: async (input) => {
    if (!input.cwd.trim() || !input.prompt.trim()) {
      return { ok: false, error: 'A working directory and a prompt are required.' };
    }
    const trigger = input.trigger ?? 'interval';
    if (trigger === 'interval' && !input.cadence?.trim()) {
      return { ok: false, error: 'An interval routine needs a cadence.' };
    }
    try {
      const res = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, trigger }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false, error: data.error ?? 'Could not create the routine.' };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  setScheduleEnabled: async (id, enabled) => {
    try {
      await fetch(`/api/schedules/${encodeURIComponent(id)}/toggle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch {
      /* broadcast-driven; a failure leaves the row as it was */
    }
  },

  deleteSchedule: async (id) => {
    try {
      await fetch(`/api/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      /* broadcast-driven */
    }
  },

  fireSchedule: async (id) => {
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(id)}/fire`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || data.ok === false) {
        return { ok: false, error: data.error ?? 'Could not start the routine.' };
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  loadScheduleRuns: async (id) => {
    try {
      const res = await fetch(`/api/schedules/${encodeURIComponent(id)}/runs`);
      const list = (await res.json()) as ScheduleRun[];
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  },

  installTeamTemplate: async (templateId, cwd, includeRoutines = true) => {
    if (!cwd.trim()) return { ok: false, error: 'Pick a project first.' };
    try {
      const res = await fetch(
        `/api/teams/templates/${encodeURIComponent(templateId)}/install`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd, includeRoutines }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        warnings?: string[];
      };
      return { ok: Boolean(data.ok), warnings: data.warnings };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  createSkill: async (input) => {
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = (await res.json().catch(() => ({}))) as {
        id?: string;
        error?: string;
      };
      if (!res.ok) return { ok: false, error: data.error ?? 'Create failed.' };
      return { ok: true, id: data.id };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  updateSkill: async (id, patch) => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: res.ok, error: data.error };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  deleteSkill: async (id) => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      return { ok: res.ok };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  restoreSkillVersion: async (id, versionId) => {
    try {
      const res = await fetch(
        `/api/skills/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
        { method: 'POST' },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: res.ok, error: data.error };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  activateLicense: async (key) => {
    try {
      const res = await fetch('/api/license/activate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      return { ok: Boolean(data.ok), error: data.error };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  abortPlan: async (planId) => {
    try {
      await fetch(`/api/plans/${encodeURIComponent(planId)}/abort`, {
        method: 'POST',
      });
    } catch {
      /* offline; the plan_upsert broadcast will reconcile if it lands */
    }
  },

  fetchTaskThread: async (planId, taskId) => {
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}/thread`,
      );
      if (!res.ok) return;
      const entries = (await res.json()) as TaskThreadEntry[];
      set((s) => ({
        threadsByTaskId: { ...s.threadsByTaskId, [taskId]: entries },
      }));
    } catch {
      /* offline; live appends will still populate as they arrive */
    }
  },

  postTaskComment: async (planId, taskId, body) => {
    const text = body.trim();
    if (!text) return { ok: false, error: 'Comment is empty.' };
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}/thread`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: text }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as
        | TaskThreadEntry
        | { error?: string };
      if (!res.ok) {
        return { ok: false, error: (data as { error?: string }).error ?? 'Failed.' };
      }
      // Merge the created entry immediately (the WS echo de-dupes by id).
      const entry = data as TaskThreadEntry;
      set((s) => {
        const existing = s.threadsByTaskId[taskId] ?? [];
        if (existing.some((e) => e.id === entry.id)) return s;
        return {
          threadsByTaskId: {
            ...s.threadsByTaskId,
            [taskId]: [...existing, entry],
          },
        };
      });
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  addFollowUp: async (planId, input) => {
    const text = input.body.trim();
    if (!text) return { ok: false, error: 'Comment is empty.' };
    try {
      const res = await fetch(
        `/api/plans/${encodeURIComponent(planId)}/follow-up`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...input, body: text }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        taskId?: string;
        upsell?: boolean;
        error?: string;
      };
      return {
        ok: Boolean(data.ok),
        taskId: data.taskId,
        upsell: data.upsell,
        error: data.error,
      };
    } catch {
      return { ok: false, error: 'Could not reach the server.' };
    }
  },

  createProject: async (name, opts) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ...opts }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        project?: Project;
        error?: string;
      };
      // The project_upsert broadcast also lands it in the store; setting it here
      // avoids a flicker if the socket round-trip is slow.
      if (data.ok && data.project) {
        const project = data.project;
        set((s) => ({ projects: { ...s.projects, [project.id]: project } }));
      }
      return { ok: Boolean(data.ok), project: data.project, error: data.error };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  resolvePermission: (requestId, approved) => {
    const send = get().send;
    send({ type: 'permission_response', requestId, approved });
    set((s) => {
      const next = { ...s.pendingPermissions };
      delete next[requestId];
      return { pendingPermissions: next };
    });
  },

  invokeAdvisor: (advisorId, prompt) => {
    const send = get().send;
    const targetSessionId = get().selectedSessionId ?? undefined;
    send({ type: 'invoke_advisor', advisorId, targetSessionId, prompt });
  },

  pinAdvisor: (advisorId) => {
    get().send({ type: 'pin_advisor', advisorId });
  },

  unpinAdvisor: (advisorId) => {
    get().send({ type: 'unpin_advisor', advisorId });
  },

  enableAdvisor: (advisorId) => {
    get().send({ type: 'set_advisor_enabled', advisorId, enabled: true });
  },

  disableAdvisor: (advisorId) => {
    get().send({ type: 'set_advisor_enabled', advisorId, enabled: false });
  },

  sendPromptTo: (sessionId, text) => {
    if (!text.trim()) return;
    get().send({ type: 'send_prompt', sessionId, text });
    // Optimistically render the user's prompt — the watcher will replace it
    // with the canonical entry from the transcript a second later.
    const optimistic: ChatEntry = {
      messageId: `pending-${Date.now()}`,
      role: 'user',
      content: text,
      ts: Date.now(),
      done: true,
      receivedAt: Date.now(),
    };
    set((s) => ({
      chatBySessionId: {
        ...s.chatBySessionId,
        [sessionId]: [...(s.chatBySessionId[sessionId] ?? []), optimistic].slice(
          -200,
        ),
      },
    }));
  },

  launchTask: (cwd, model, initialPrompt, opts) => {
    get().send({
      type: 'launch_session',
      cwd,
      model,
      initialPrompt,
      worktreeBranch: opts?.worktreeBranch,
      worktreeBaseRef: opts?.worktreeBaseRef,
      useAgentView: opts?.useAgentView,
      agentName: opts?.agentName,
      budgetUsd: opts?.budgetUsd,
      goalId: opts?.goalId,
    });
  },

  raiseBudget: (sessionId, budgetUsd) => {
    get().send({ type: 'raise_budget', sessionId, budgetUsd });
    // Optimistically clear the alert; the server confirms via cost_update.
    set((s) => {
      const next = { ...s.budgetAlerts };
      delete next[sessionId];
      return { budgetAlerts: next };
    });
  },
  dismissBudgetAlert: (sessionId) => {
    get().send({ type: 'dismiss_budget_alert', sessionId });
    set((s) => {
      const next = { ...s.budgetAlerts };
      delete next[sessionId];
      return { budgetAlerts: next };
    });
  },

  selectedSessionIds: new Set<string>(),
  toggleSessionSelection: (id) => {
    set((s) => {
      const next = new Set(s.selectedSessionIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedSessionIds: next };
    });
  },
  clearSessionSelection: () => {
    set({ selectedSessionIds: new Set<string>() });
  },
  terminateSessions: (ids) => {
    const send = get().send;
    for (const sessionId of ids) {
      send({ type: 'terminate_session', sessionId });
    }
    set({ selectedSessionIds: new Set<string>() });
  },

  setMotionEnabled: (b) => {
    writeMotionPref(b);
    set({ motionEnabled: b });
  },
  toggleMotion: () => {
    const next = !get().motionEnabled;
    writeMotionPref(next);
    set({ motionEnabled: next });
  },
  setViewMode: (m) => {
    writeViewPref(m);
    set({ viewMode: m });
  },
  toggleViewMode: () => {
    const order = ['galaxy', 'list', 'missions'] as const;
    const cur = get().viewMode;
    const idx = order.indexOf(cur);
    const next = order[(idx + 1) % order.length] ?? 'galaxy';
    writeViewPref(next);
    set({ viewMode: next });
  },

  enterPlayback: (events, earliestMs, latestMs) => {
    const start = earliestMs;
    set((s) => ({
      playback: {
        ...s.playback,
        active: true,
        loading: false,
        events,
        earliestMs,
        latestMs,
        currentMs: start,
        playing: false,
        ...derivePlaybackSnapshot(events, start, get().sessions, get().missions),
      },
    }));
  },
  exitPlayback: () => set({ playback: EMPTY_PLAYBACK }),
  setPlaybackTime: (ms) => {
    set((s) => {
      const clamped = Math.max(s.playback.earliestMs, Math.min(ms, s.playback.latestMs));
      return {
        playback: {
          ...s.playback,
          currentMs: clamped,
          ...derivePlaybackSnapshot(
            s.playback.events,
            clamped,
            get().sessions,
            get().missions,
          ),
        },
      };
    });
  },
  setPlaybackSpeed: (speed) =>
    set((s) => ({ playback: { ...s.playback, speed } })),
  setPlaybackPlaying: (playing) =>
    set((s) => ({ playback: { ...s.playback, playing } })),
  setPlaybackLoading: (loading) =>
    set((s) => ({ playback: { ...s.playback, loading } })),

  send: () => {
    /* replaced when socket attaches */
  },
  attachSocket: (send) => set({ send }),
}));

function effectiveSessions(state: SolixState): Record<string, Session> {
  return state.playback.active
    ? state.playback.derivedSessions
    : state.sessions;
}

export function selectPlanets(state: SolixState): Session[] {
  return Object.values(effectiveSessions(state)).filter(
    (s) => !s.parentSessionId && s.kind !== 'advisor',
  );
}

export function selectAdvisorPlanets(state: SolixState): Session[] {
  return Object.values(effectiveSessions(state)).filter(
    (s) => !s.parentSessionId && s.kind === 'advisor',
  );
}

export function selectMoons(state: SolixState, planetId: string): Session[] {
  return Object.values(effectiveSessions(state)).filter(
    (s) => s.parentSessionId === planetId,
  );
}

export interface WorkspaceSummary {
  totalSpendUsd: number;
  totalTokens: number;
  completedMissions: number;
  costPerCompletedMission: number;
  interventions: number;
  pendingPermissions: number;
  activeCount: number;
  attentionCount: number;
  idleCount: number;
  missions: { completed: number; failed: number; active: number; cancelled: number };
  sessionCount: number;
  projectCount: number;
  advisorCount: number;
  skillCount: number;
  needsYou: Session[];
  contextAvgPct: number;
  contextMaxPct: number;
}

/**
 * Whole-workspace aggregate for the Sun's "Mission Control" panel. Pure
 * derivation over the current sessions/missions — no new tracking. `interventions`
 * is filled from the persisted audit log by the panel itself (async); everything
 * here is synchronous from store state.
 */
export function selectWorkspaceSummary(state: SolixState): WorkspaceSummary {
  const planets = selectPlanets(state);
  let totalSpendUsd = 0;
  let activeCount = 0;
  let attentionCount = 0;
  let idleCount = 0;
  let ctxSum = 0;
  let ctxMax = 0;
  let ctxN = 0;
  const needsYou: Session[] = [];
  for (const s of planets) {
    totalSpendUsd += s.costUsd ?? 0;
    if (s.status === 'active') activeCount++;
    else if (
      s.status === 'awaiting_permission' ||
      s.status === 'awaiting_input' ||
      s.status === 'plan_review'
    )
      attentionCount++;
    else if (s.status === 'idle') idleCount++;
    if (
      s.status === 'awaiting_permission' ||
      s.status === 'awaiting_input' ||
      s.status === 'error'
    )
      needsYou.push(s);
    if (typeof s.contextUsagePct === 'number') {
      ctxSum += s.contextUsagePct;
      ctxMax = Math.max(ctxMax, s.contextUsagePct);
      ctxN++;
    }
  }

  let totalTokens = 0;
  let completed = 0;
  let failed = 0;
  let activeM = 0;
  let cancelled = 0;
  for (const m of Object.values(state.missions)) {
    totalTokens += m.metrics?.totalTokens ?? 0;
    if (m.status === 'completed') completed++;
    else if (m.status === 'failed') failed++;
    else if (m.status === 'active') activeM++;
    else if (m.status === 'cancelled') cancelled++;
  }

  return {
    totalSpendUsd,
    totalTokens,
    completedMissions: completed,
    costPerCompletedMission: completed > 0 ? totalSpendUsd / completed : 0,
    interventions: 0,
    pendingPermissions: Object.keys(state.pendingPermissions).length,
    activeCount,
    attentionCount,
    idleCount,
    missions: { completed, failed, active: activeM, cancelled },
    sessionCount: planets.length,
    projectCount: Object.keys(state.projects).length,
    advisorCount: Object.keys(state.advisors).length,
    skillCount: Object.keys(state.skills).length,
    needsYou,
    contextAvgPct: ctxN > 0 ? ctxSum / ctxN : 0,
    contextMaxPct: ctxMax,
  };
}

export function selectVisibleToolCalls(state: SolixState): RecentToolCall[] {
  return state.playback.active
    ? state.playback.derivedToolCalls
    : state.recentToolCalls;
}

export function selectEnabledAdvisors(state: SolixState): Advisor[] {
  return Object.values(state.advisors).filter((a) => a.enabled);
}

export function selectOptInAdvisors(state: SolixState): Advisor[] {
  return Object.values(state.advisors).filter((a) => !a.enabled);
}

export function selectAllAdvisors(state: SolixState): Advisor[] {
  return Object.values(state.advisors).sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.codename.localeCompare(b.codename);
  });
}

export function selectSkillsArray(state: SolixState): Skill[] {
  return Object.values(state.skills);
}

/**
 * Pending permissions in the order the Decision Queue displays them: newest
 * first.
 *
 * This exists because the keyboard shortcut and the queue used to derive their
 * own order independently, and the two were exact opposites — the handler took
 * `Object.values(pendingPermissions)[0]` (insertion order, i.e. OLDEST first)
 * while the queue sorted newest-first. With two or more pending requests,
 * pressing `Y` approved the card at the BOTTOM of the list rather than the one
 * on screen. Approving an agent action the human never saw is the worst failure
 * this product can have, so both callers now read this one function.
 */
/**
 * How far the Decision Queue (and the scene controls) must sit from the right
 * edge. Derived from the single open panel rather than a hardcoded if-chain
 * that re-stated three different CSS widths and assumed one panel was open.
 */
export function selectDockOffsetPx(state: SolixState): number {
  return state.activePanel ? RIGHT_DOCK_WIDTH_PX : 0;
}

/**
 * How far anything floating over the main area must sit from the LEFT edge.
 *
 * The companion to selectDockOffsetPx. Overlays now have two things to clear —
 * the nav rail on one side and a contextual dock on the other — and the
 * Decision Queue has to clear both. Getting either term wrong puts a pending
 * permission request underneath something, which is the failure this pair of
 * selectors exists to make impossible.
 */
export function selectRailWidthPx(_state: SolixState): number {
  return RAIL_WIDTH_PX;
}

export function selectPendingPermissionsOrdered(
  state: SolixState,
): PendingPermission[] {
  return Object.values(state.pendingPermissions).sort(
    (a, b) => b.receivedAt - a.receivedAt,
  );
}

/** Enabled routines only — the galaxy's pulsing heartbeat nodes depend on this
 *  filter, so do not widen it. The Fleet > Routines tab wants every routine,
 *  including the disabled ones it needs to offer re-enabling. */
export function selectEnabledSchedules(state: SolixState): ScheduledTask[] {
  return Object.values(state.schedules).filter((s) => s.enabled);
}

/** Every routine, newest-firing first, disabled ones last. */
export function selectSchedulesArray(state: SolixState): ScheduledTask[] {
  return Object.values(state.schedules).sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.nextRunAt - b.nextRunAt;
  });
}

export function selectGoalsArray(state: SolixState): Goal[] {
  return Object.values(state.goals);
}

// ── v2 Maestro selectors ───────────────────────────────────────────────
const DEFAULT_ORG = 'org-default';

/** A plan/goal with no orgId belongs to the default org (pre-migration rows). */
function inCurrentOrg(orgId: string | undefined, currentOrgId: string): boolean {
  return (orgId ?? DEFAULT_ORG) === currentOrgId;
}

/** Plans in the currently-selected org (P3 #10), newest first. */
export function selectPlansArray(state: SolixState): Plan[] {
  return Object.values(state.plans)
    .filter((p) => inCurrentOrg(p.orgId, state.currentOrgId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Tasks for one plan, in display order. */
export function selectPlanTasks(state: SolixState, planId: string): PlanTask[] {
  return Object.values(state.planTasks)
    .filter((t) => t.planId === planId)
    .sort((a, b) => a.orderIndex - b.orderIndex || a.createdAt - b.createdAt);
}

/** A task's thread entries (chronological), or an empty array if not loaded. */
export function selectTaskThread(
  state: SolixState,
  taskId: string,
): TaskThreadEntry[] {
  return state.threadsByTaskId[taskId] ?? [];
}

/** The most recent plan that is still live (not completed/failed), if any. */
export function selectActivePlan(state: SolixState): Plan | null {
  return (
    selectPlansArray(state).find(
      (p) => p.status !== 'completed' && p.status !== 'failed',
    ) ?? null
  );
}

/**
 * Focus mode — true when *anything* is selected (a session, an advisor, or
 * a skill). When focus is active, planets that aren't the focused one dim
 * to ~25% opacity so the eye lands on the selection.
 */
export function selectFocusActive(state: SolixState): boolean {
  return Boolean(
    state.selectedSessionId ||
      state.selectedAdvisorId ||
      state.selectedSkillId,
  );
}

/**
 * Returns true when this session is the currently-focused one (or its
 * parent / pinned advisor session is). Used to leave the focused planet
 * (and its moons) at full brightness while dimming the rest.
 */
export function isSessionFocused(
  state: SolixState,
  session: Session,
): boolean {
  if (state.selectedSessionId === session.id) return true;
  if (
    session.parentSessionId &&
    state.selectedSessionId === session.parentSessionId
  ) {
    return true;
  }
  if (state.selectedAdvisorId && session.advisorRole) {
    return state.selectedAdvisorId === session.advisorRole;
  }
  return false;
}
