import { nanoid } from 'nanoid';
import type { GalaxyManifest, HookEvent, Model } from '@solix/shared';
import type { DB } from './db.js';
import type { Broadcaster } from './broadcaster.js';
import { ensureProject } from './state/projects.js';
import {
  clearSessionWrapper,
  getSession,
  setSessionBudget,
  setSessionContextUsage,
  setSessionCost,
  setSessionGoal,
  setSessionMission,
  setSessionStatus,
  upsertSession,
} from './state/sessions.js';
import {
  addMissionTokens,
  addTouchedFile,
  bumpSubagentCount,
  bumpToolCallCount,
  completeMission,
  getMission,
  setMissionError,
  startMission,
} from './state/missions.js';
import { recordToolCall } from './state/toolcalls.js';
import {
  getAdvisor,
  setAdvisorEnabled as setAdvisorEnabledState,
  setAdvisorPinned,
} from './state/advisors.js';
import { buildContextEnvelope } from './state/context.js';
import { recordAudit } from './state/audit.js';
import { evaluateContainment } from './containment.js';
import {
  bindWrapperToSession,
  claimWrapperForCwd,
  writeToWrapperSocket,
} from './state/wrappers.js';
import type { Launcher } from './launcher.js';
import type { TranscriptWatcherManager } from './state/transcript.js';

interface PendingPermission {
  requestId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  createdAt: number;
  // Set only for *blocking* gate requests (the synchronous PreToolUse path).
  // resolvePermission calls this to release the held HTTP request; the timer
  // is the server-side backstop when no human answers.
  resolve?: (approved: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class EventRouter {
  private permissions = new Map<string, PendingPermission>();

  constructor(
    private db: DB,
    private broadcaster: Broadcaster,
    private launcher?: Launcher,
    private transcripts?: TranscriptWatcherManager,
  ) {}

  setLauncher(launcher: Launcher): void {
    this.launcher = launcher;
  }

  handleHookEvent(event: HookEvent): void {
    try {
      switch (event.event) {
        case 'session_start':
          this.onSessionStart(event);
          break;
        case 'user_prompt_submit':
          this.onUserPromptSubmit(event);
          break;
        case 'stop':
          this.onStop(event);
          break;
        case 'subagent_stop':
          this.onSubagentStop(event);
          break;
        case 'pre_tool_task':
          this.onPreToolTask(event);
          break;
        case 'pre_tool_file':
          this.onPreToolFile(event);
          break;
        case 'pre_tool_bash':
          this.onPreToolBash(event);
          break;
        case 'post_tool':
          this.onPostTool(event);
          break;
        case 'notification':
          this.onNotification(event);
          break;
        default:
          console.warn('[router] unknown event', event);
      }
    } catch (err) {
      console.error('[router] error handling event', event.event, err);
    }
  }

  private extractSessionId(event: HookEvent): string {
    const p = event.payload as Record<string, unknown>;
    if (typeof p.session_id === 'string') return p.session_id;
    if (typeof p.sessionId === 'string') return p.sessionId;
    return `pid-${event.pid}`;
  }

  private extractParentSessionId(event: HookEvent): string | undefined {
    const p = event.payload as Record<string, unknown>;
    if (typeof p.parent_session_id === 'string') return p.parent_session_id;
    if (typeof p.parentSessionId === 'string') return p.parentSessionId;
    return undefined;
  }

  private extractModel(event: HookEvent): Model {
    const p = event.payload as Record<string, unknown>;
    const m = p.model;
    if (typeof m === 'string') return m as Model;
    return 'default';
  }

  private onSessionStart(event: HookEvent): void {
    const project = ensureProject(this.db, event.cwd);
    const sessionId = this.extractSessionId(event);
    const advisorRole = this.launcher?.advisorRoleForPid(event.pid);
    // If this session was launched into a Solix-managed worktree, the
    // launcher recorded its path under the spawn cwd. Persisting it here
    // means List view can render a "branch" chip without re-shelling git.
    const worktreePath = this.launcher?.worktreePathForInternalCwd(event.cwd);
    // Sprint M: budget cap + goal recorded at launch (keyed by cwd).
    const launchBudget = this.launcher?.budgetForInternalCwd(event.cwd);
    const launchGoal = this.launcher?.goalForInternalCwd(event.cwd);
    // If the user ran `solix run` (Sprint J wrapper) instead of bare
    // `claude`, a wrapper registration with this cwd will be in the
    // ephemeral registry. Claim it now so the SidePanel composer
    // becomes write-enabled for this session.
    const wrapper = claimWrapperForCwd(event.cwd);
    const session = upsertSession(this.db, {
      id: sessionId,
      pid: event.pid,
      projectId: project.id,
      cwd: event.cwd,
      origin:
        (event.payload as Record<string, unknown>).origin === 'internal'
          ? 'internal'
          : advisorRole
            ? 'internal'
            : 'external',
      model: this.extractModel(event),
      parentSessionId: this.extractParentSessionId(event),
      kind: advisorRole ? 'advisor' : 'user',
      advisorRole,
      worktreePath,
      wrapperSocketPath: wrapper?.socketPath,
      runtime:
        (event.payload as Record<string, unknown>).runtime === 'codex'
          ? 'codex'
          : 'claude',
    });
    // Once the session row exists we can record the wrapperId →
    // sessionId binding. On unregister we use it to clear the
    // session's wrapper_socket_path.
    if (wrapper) bindWrapperToSession(wrapper.wrapperId, session.id);
    // Persist the launch-time budget/goal so the planet shows a budget ring
    // and joins its goal constellation from the first frame.
    let enriched = session;
    if (launchBudget != null) {
      enriched = setSessionBudget(this.db, session.id, launchBudget) ?? enriched;
    }
    if (launchGoal) {
      enriched = setSessionGoal(this.db, session.id, launchGoal) ?? enriched;
    }
    this.broadcaster.broadcast({ type: 'session_upsert', session: enriched });
    // Start tailing the session's transcript so the Chat tab streams in real
    // time. Skipped for moons (subagents) — they share the parent's transcript —
    // and for Maestro workers/verifiers, whose cost the orchestrator records
    // directly from the run result (avoids a double-count + a watcher leak).
    const role = enriched.sessionRole;
    if (
      !session.parentSessionId &&
      role !== 'worker' &&
      role !== 'verifier'
    ) {
      this.transcripts?.startWatching(sessionId, event.cwd);
    }
  }

  private onUserPromptSubmit(event: HookEvent): void {
    const sessionId = this.extractSessionId(event);
    const p = event.payload as Record<string, unknown>;
    const prompt =
      typeof p.prompt === 'string' ? p.prompt : 'untitled prompt';

    let session = getSession(this.db, sessionId);
    if (!session) {
      const project = ensureProject(this.db, event.cwd);
      session = upsertSession(this.db, {
        id: sessionId,
        pid: event.pid,
        projectId: project.id,
        cwd: event.cwd,
        origin: 'external',
        model: this.extractModel(event),
      });
    }

    const mission = startMission(this.db, sessionId, prompt, session.currentGoalId);
    const updated = setSessionMission(this.db, sessionId, mission.id);
    const active = updated
      ? setSessionStatus(this.db, sessionId, 'active')
      : null;

    this.broadcaster.broadcast({ type: 'mission_upsert', mission });
    if (active) {
      this.broadcaster.broadcast({ type: 'session_upsert', session: active });
    }
  }

  private onStop(event: HookEvent): void {
    const sessionId = this.extractSessionId(event);
    const session = getSession(this.db, sessionId);
    if (!session) return;

    // Maestro workers/verifiers are owned by the orchestrator, which drives their
    // lifecycle off the launcher process exit. Don't let the stop hook flip their
    // status/mission (it would race terminateRow and leave planets stuck idle).
    if (session.sessionRole === 'worker' || session.sessionRole === 'verifier') {
      return;
    }

    if (session.currentMissionId) {
      const mission = completeMission(
        this.db,
        session.currentMissionId,
        'completed',
      );
      if (mission) {
        this.broadcaster.broadcast({ type: 'mission_upsert', mission });
      }
    }

    const updated = setSessionMission(this.db, sessionId, null);
    const idle = updated
      ? setSessionStatus(this.db, sessionId, 'idle')
      : null;
    if (idle) {
      this.broadcaster.broadcast({ type: 'session_upsert', session: idle });
    }
  }

  private onSubagentStop(event: HookEvent): void {
    const subSessionId = this.extractSessionId(event);
    const session = getSession(this.db, subSessionId);
    if (!session) return;
    const terminated = setSessionStatus(this.db, subSessionId, 'terminated');
    if (terminated) {
      this.broadcaster.broadcast({
        type: 'session_remove',
        sessionId: subSessionId,
      });
    }
  }

  private onPreToolTask(event: HookEvent): void {
    const parentSessionId = this.extractSessionId(event);
    const parent = getSession(this.db, parentSessionId);
    if (!parent) return;

    const subId = nanoid();
    const sub = upsertSession(this.db, {
      id: subId,
      pid: event.pid,
      projectId: parent.projectId,
      cwd: event.cwd,
      origin: parent.origin,
      model: parent.model,
      parentSessionId: parentSessionId,
    });
    const active = setSessionStatus(this.db, subId, 'active');

    if (parent.currentMissionId) {
      bumpSubagentCount(this.db, parent.currentMissionId);
      const mission = getMission(this.db, parent.currentMissionId);
      if (mission)
        this.broadcaster.broadcast({ type: 'mission_upsert', mission });
    }

    this.broadcaster.broadcast({
      type: 'session_upsert',
      session: active ?? sub,
    });
  }

  private onPreToolFile(event: HookEvent): void {
    const sessionId = this.extractSessionId(event);
    const session = getSession(this.db, sessionId);
    if (!session) return;
    const p = event.payload as Record<string, unknown>;
    const tool =
      typeof p.tool_name === 'string' ? p.tool_name : 'File';
    const filePath =
      typeof p.file_path === 'string'
        ? p.file_path
        : typeof (p.tool_input as { file_path?: string })?.file_path ===
            'string'
          ? (p.tool_input as { file_path?: string }).file_path!
          : '';

    const toolCall = recordToolCall(this.db, {
      sessionId,
      missionId: session.currentMissionId,
      tool,
      args: { file_path: filePath },
    });

    if (session.currentMissionId && filePath) {
      addTouchedFile(this.db, session.currentMissionId, filePath);
    }

    this.broadcaster.broadcast({ type: 'tool_call', toolCall });
  }

  private onPreToolBash(event: HookEvent): void {
    const sessionId = this.extractSessionId(event);
    const session = getSession(this.db, sessionId);
    if (!session) return;
    const p = event.payload as Record<string, unknown>;
    const command =
      typeof p.command === 'string'
        ? p.command
        : typeof (p.tool_input as { command?: string })?.command === 'string'
          ? (p.tool_input as { command?: string }).command!
          : '';
    const toolCall = recordToolCall(this.db, {
      sessionId,
      missionId: session.currentMissionId,
      tool: 'Bash',
      args: { command },
    });
    this.broadcaster.broadcast({ type: 'tool_call', toolCall });
  }

  private onPostTool(event: HookEvent): void {
    const sessionId = this.extractSessionId(event);
    const session = getSession(this.db, sessionId);
    if (!session?.currentMissionId) return;
    bumpToolCallCount(this.db, session.currentMissionId);

    // Capture tool failures so the Mission view can surface why something
    // went wrong. Claude Code's post-tool hook payload puts the result
    // under `tool_response`; an `is_error: true` flag (with the error
    // text in `content`) signals a failure.
    const payload = event.payload as Record<string, unknown>;
    const toolResponse = payload.tool_response as
      | { is_error?: boolean; content?: unknown }
      | undefined;
    let updated = getMission(this.db, session.currentMissionId);
    if (toolResponse?.is_error) {
      const raw =
        typeof toolResponse.content === 'string'
          ? toolResponse.content
          : JSON.stringify(toolResponse.content ?? '');
      const summary = raw.slice(0, 280).replace(/\s+/g, ' ').trim();
      if (summary) {
        updated = setMissionError(this.db, session.currentMissionId, summary);
      }
    }
    if (updated)
      this.broadcaster.broadcast({ type: 'mission_upsert', mission: updated });
  }

  private onNotification(event: HookEvent): void {
    const sessionId = this.extractSessionId(event);
    const p = event.payload as Record<string, unknown>;
    const message =
      typeof p.message === 'string' ? p.message : 'Notification';

    // Always surface as a toast so the user sees Claude Code's status pings.
    this.broadcaster.broadcast({
      type: 'toast',
      level: 'warn',
      message,
    });

    // Only promote to a permission decision when the notification actually
    // describes a tool call. Claude Code fires Notification hooks for benign
    // status pings (e.g. "Claude is waiting for your input") with no tool_name;
    // those shouldn't render an Approve/Deny modal labelled "unknown" or flip
    // the session into `awaiting_permission`.
    if (typeof p.tool_name !== 'string') return;

    const tool = p.tool_name;
    const requestId = nanoid();
    this.permissions.set(requestId, {
      requestId,
      sessionId,
      tool,
      args: (p.tool_input as Record<string, unknown>) ?? {},
      createdAt: Date.now(),
    });

    const updated = setSessionStatus(this.db, sessionId, 'awaiting_permission');
    if (updated) {
      this.broadcaster.broadcast({
        type: 'session_upsert',
        session: updated,
      });
    }
    this.broadcaster.broadcast({
      type: 'permission_request',
      sessionId,
      tool,
      args: (p.tool_input as Record<string, unknown>) ?? {},
      requestId,
    });
  }

  /**
   * Synchronous human-in-the-loop gate for the blocking PreToolUse path.
   * Records the tool call (so the comet/timeline visuals still fire — the gate
   * hook no longer POSTs to /events), broadcasts a permission_request, and
   * returns a promise that resolves when a human answers via `permission_response`
   * (reused unchanged) or when the server-side timeout fires.
   */
  requestPermission(
    event: HookEvent,
  ): Promise<{ approved: boolean; timedOut: boolean }> {
    const sessionId = this.extractSessionId(event);
    const p = event.payload as Record<string, unknown>;
    const { tool, args } = this.describeGatedTool(event.event, p);

    const session = getSession(this.db, sessionId);
    if (session) {
      const toolCall = recordToolCall(this.db, {
        sessionId,
        missionId: session.currentMissionId,
        tool,
        args,
      });
      if (
        event.event === 'pre_tool_file' &&
        session.currentMissionId &&
        typeof args.file_path === 'string' &&
        args.file_path
      ) {
        addTouchedFile(this.db, session.currentMissionId, args.file_path);
      }
      this.broadcaster.broadcast({ type: 'tool_call', toolCall });

      // Containment (Sentinel): an autonomous worker/verifier tool call that
      // hits the denylist or writes outside the project is HARD-denied here —
      // before the human/full-auto path — so full-auto can't degrade to
      // auto-allow. Non-contained roles fall through to the normal gate.
      const containment = evaluateContainment({
        role: session.sessionRole,
        tool,
        command: typeof args.command === 'string' ? args.command : undefined,
        filePath: typeof args.file_path === 'string' ? args.file_path : undefined,
        cwd: session.cwd,
      });
      if (containment.blocked) {
        recordAudit(this.db, {
          kind: 'command_blocked',
          sessionId,
          summary: `Containment blocked ${tool}: ${containment.reason}`,
          payload: {
            tool,
            reason: containment.reason,
            command: typeof args.command === 'string' ? args.command : undefined,
          },
        });
        this.broadcaster.broadcast({
          type: 'toast',
          level: 'warn',
          message: `Containment blocked ${tool}: ${containment.reason}`,
        });
        const active = setSessionStatus(this.db, sessionId, 'active');
        if (active)
          this.broadcaster.broadcast({ type: 'session_upsert', session: active });
        return Promise.resolve({ approved: false, timedOut: false });
      }

      // An autonomous worker/verifier has no human at the keyboard: a SAFE tool
      // call (passed containment) auto-allows so the fleet can proceed. The
      // denylist + cwd-confinement above is the boundary, not a per-step prompt.
      if (
        session.sessionRole === 'worker' ||
        session.sessionRole === 'verifier' ||
        session.sessionRole === 'routine'
      ) {
        return Promise.resolve({ approved: true, timedOut: false });
      }
    }

    const requestId = nanoid();
    const timeoutMs = Number(process.env.SOLIX_GATE_TIMEOUT_MS ?? 300_000);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.permissions.get(requestId);
        if (!pending) return;
        this.permissions.delete(requestId);
        const s = setSessionStatus(this.db, sessionId, 'active');
        if (s) this.broadcaster.broadcast({ type: 'session_upsert', session: s });
        resolve({ approved: false, timedOut: true });
      }, timeoutMs);

      this.permissions.set(requestId, {
        requestId,
        sessionId,
        tool,
        args,
        createdAt: Date.now(),
        resolve: (approved: boolean) => resolve({ approved, timedOut: false }),
        timer,
      });

      const updated = setSessionStatus(
        this.db,
        sessionId,
        'awaiting_permission',
      );
      if (updated) {
        this.broadcaster.broadcast({ type: 'session_upsert', session: updated });
      }
      this.broadcaster.broadcast({
        type: 'permission_request',
        sessionId,
        tool,
        args,
        requestId,
      });
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'warn',
        message: `Approval requested: ${tool}`,
      });
    });
  }

  private describeGatedTool(
    eventName: HookEvent['event'],
    p: Record<string, unknown>,
  ): { tool: string; args: Record<string, unknown> } {
    const toolInput = (p.tool_input as Record<string, unknown>) ?? {};
    if (eventName === 'pre_tool_bash') {
      const command =
        typeof p.command === 'string'
          ? p.command
          : typeof toolInput.command === 'string'
            ? toolInput.command
            : '';
      return { tool: 'Bash', args: { command } };
    }
    if (eventName === 'pre_tool_file') {
      const tool = typeof p.tool_name === 'string' ? p.tool_name : 'File';
      const filePath =
        typeof p.file_path === 'string'
          ? p.file_path
          : typeof toolInput.file_path === 'string'
            ? toolInput.file_path
            : '';
      return { tool, args: { file_path: filePath } };
    }
    if (eventName === 'pre_tool_task') {
      const tool = typeof p.tool_name === 'string' ? p.tool_name : 'Task';
      return { tool, args: toolInput };
    }
    const tool = typeof p.tool_name === 'string' ? p.tool_name : 'tool';
    return { tool, args: toolInput };
  }

  invokeAdvisor(
    advisorId: string,
    targetSessionId?: string,
    prompt?: string,
  ): { ok: boolean; envelope?: string } {
    const advisor = getAdvisor(this.db, advisorId);
    if (!advisor) return { ok: false };
    const envelope = buildContextEnvelope(this.db, {
      advisorId,
      targetSessionId,
      userPrompt: prompt,
    });
    if (!envelope) return { ok: false };

    const target = envelope.targetSession;
    const targetLabel = target
      ? `${target.name ?? target.id.slice(0, 8)}`
      : 'project level';
    this.broadcaster.broadcast({
      type: 'toast',
      level: 'info',
      message: `Invoke ${advisor.codename} → ${targetLabel} · ${envelope.recentMissions.length} mission(s) in envelope`,
    });
    recordAudit(this.db, {
      kind: 'advisor_invoked',
      advisorId,
      sessionId: target?.id,
      projectId: target?.projectId,
      summary: `Invoked ${advisor.codename} → ${targetLabel}`,
      payload: { prompt, missionsInEnvelope: envelope.recentMissions.length },
    });
    return { ok: true, envelope: envelope.prompt };
  }

  pinAdvisor(advisorId: string, cwd: string = process.cwd()): boolean {
    if (!this.launcher) {
      // No launcher available — flip DB state but don't spawn anything.
      const advisor = setAdvisorPinned(this.db, advisorId, true);
      if (!advisor) return false;
      this.broadcaster.broadcast({ type: 'advisor_upsert', advisor });
      recordAudit(this.db, {
        kind: 'advisor_pinned',
        advisorId,
        summary: `Pinned ${advisor.codename}`,
      });
      return true;
    }
    const ok = this.launcher.pin(advisorId, cwd);
    const advisor = getAdvisor(this.db, advisorId);
    if (advisor) {
      this.broadcaster.broadcast({ type: 'advisor_upsert', advisor });
      if (ok) {
        recordAudit(this.db, {
          kind: 'advisor_pinned',
          advisorId,
          summary: `Pinned ${advisor.codename} in ${cwd}`,
        });
      }
    }
    return ok;
  }

  /** Sprint N — enable/disable an advisor and broadcast the change so open
   * browsers (and the CLI path) update live. Returns the updated advisor. */
  setAdvisorEnabled(
    advisorId: string,
    enabled: boolean,
  ): import('@solix/shared').Advisor | null {
    const advisor = setAdvisorEnabledState(this.db, advisorId, enabled);
    if (advisor) {
      this.broadcaster.broadcast({ type: 'advisor_upsert', advisor });
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'info',
        message: `${advisor.codename} ${enabled ? 'added to crew' : 'disabled'}`,
      });
    }
    return advisor;
  }

  unpinAdvisor(advisorId: string): boolean {
    if (this.launcher) {
      this.launcher.unpin(advisorId);
    } else {
      setAdvisorPinned(this.db, advisorId, false);
    }
    const advisor = getAdvisor(this.db, advisorId);
    if (advisor) {
      this.broadcaster.broadcast({ type: 'advisor_upsert', advisor });
      recordAudit(this.db, {
        kind: 'advisor_unpinned',
        advisorId,
        summary: `Unpinned ${advisor.codename}`,
      });
    }
    return true;
  }

  resolvePermission(requestId: string, approved: boolean): boolean {
    const pending = this.permissions.get(requestId);
    if (!pending) return false;
    this.permissions.delete(requestId);
    // Blocking gate request: release the held HTTP response so the hook can
    // return Claude Code the decision, and cancel the server-side timeout.
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.resolve) pending.resolve(approved);
    const status = approved ? 'active' : 'idle';
    const session = setSessionStatus(this.db, pending.sessionId, status);
    if (session)
      this.broadcaster.broadcast({ type: 'session_upsert', session });
    const argSummary = (() => {
      const k = Object.keys(pending.args)[0];
      if (!k) return '';
      const v = pending.args[k];
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return `: ${s.length > 80 ? s.slice(0, 80) + '…' : s}`;
    })();
    recordAudit(this.db, {
      kind: approved ? 'permission_approved' : 'permission_denied',
      sessionId: pending.sessionId,
      projectId: session?.projectId,
      summary: `${approved ? 'Approved' : 'Denied'} ${pending.tool} for ${session?.name ?? pending.sessionId.slice(0, 8)}${argSummary}`,
      payload: { tool: pending.tool, args: pending.args },
    });
    return true;
  }

  launchInternalSession(opts: {
    cwd: string;
    model?: Model;
    initialPrompt?: string;
    worktreeBranch?: string;
    worktreeBaseRef?: string;
    useAgentView?: boolean;
    agentName?: string;
    budgetUsd?: number;
    goalId?: string;
  }): { ok: boolean; sessionId?: string } {
    if (!this.launcher) return { ok: false };
    if (!opts.initialPrompt?.trim()) {
      this.broadcaster.broadcast({
        type: 'toast',
        level: 'warn',
        message: 'Launch needs an initial prompt',
      });
      return { ok: false };
    }
    return this.launcher.launch({
      cwd: opts.cwd,
      model: opts.model,
      initialPrompt: opts.initialPrompt,
      worktreeBranch: opts.worktreeBranch,
      worktreeBaseRef: opts.worktreeBaseRef,
      useAgentView: opts.useAgentView,
      agentName: opts.agentName,
      budgetUsd: opts.budgetUsd,
      goalId: opts.goalId,
    });
  }

  /** Sprint M — raise (or clear) a session's budget cap. Clears any standing
   * budget breach by re-broadcasting the current cost against the new cap. */
  raiseBudget(sessionId: string, budgetUsd: number): void {
    const session = setSessionBudget(this.db, sessionId, budgetUsd);
    if (!session) return;
    this.broadcaster.broadcast({ type: 'session_upsert', session });
    this.broadcaster.broadcast({
      type: 'cost_update',
      sessionId,
      costUsd: session.costUsd,
      budgetUsd: session.budgetUsd,
    });
    this.broadcaster.broadcast({
      type: 'toast',
      level: 'info',
      message: `Budget raised to $${budgetUsd.toFixed(2)} for ${session.name ?? sessionId.slice(0, 8)}`,
    });
  }

  sendPromptToSession(sessionId: string, text: string): boolean {
    const session = getSession(this.db, sessionId);
    if (!session) return false;

    // Sprint J: external sessions started via `solix run` carry the
    // wrapper's Unix socket path. Forward the prompt over the socket
    // so the wrapper can write it into the underlying claude PTY.
    if (session.wrapperSocketPath) {
      const ok = writeToWrapperSocket(session.wrapperSocketPath, text);
      if (ok) {
        // Echo the user's prompt into the chat so the SidePanel
        // shows it immediately, before claude streams its reply.
        this.broadcaster.broadcast({
          type: 'chat_delta',
          sessionId,
          delta: {
            messageId: `u-${Date.now()}`,
            role: 'user',
            content: text,
            ts: Date.now(),
            done: true,
          },
        });
      } else {
        // Socket file is gone or unwritable — wrapper exited without
        // unregistering cleanly (kill -9, crash, etc.). Clear the
        // stored path so future sends don't keep failing silently,
        // and tell the user.
        const cleared = clearSessionWrapper(this.db, sessionId);
        if (cleared)
          this.broadcaster.broadcast({ type: 'session_upsert', session: cleared });
        this.broadcaster.broadcast({
          type: 'toast',
          level: 'warn',
          message: `Wrapper for ${session.name ?? session.id.slice(0, 8)} exited — chat is now read-only. Restart with \`solix run\`.`,
        });
      }
      return ok;
    }

    // Internal sessions go through the launcher (existing behavior).
    if (!this.launcher) return false;
    return this.launcher.sendPromptToInternal(sessionId, text);
  }

  /** Pending permission requests, used by the WS snapshot so a fresh
   * client connection sees what's already waiting on the server. */
  pendingPermissions(): PendingPermission[] {
    return [...this.permissions.values()];
  }

  /** Public re-broadcast helper for cases where state mutates outside
   * the hook flow (e.g. wrapper unregister clearing the socket path). */
  broadcastSessionUpsert(session: import('@solix/shared').Session): void {
    this.broadcaster.broadcast({ type: 'session_upsert', session });
  }

  // Sprint M — broadcast helpers for schedule/goal CRUD driven by HTTP/CLI.
  broadcastScheduleUpsert(schedule: import('@solix/shared').ScheduledTask): void {
    this.broadcaster.broadcast({ type: 'schedule_upsert', schedule });
  }
  broadcastScheduleRemove(scheduleId: string): void {
    this.broadcaster.broadcast({ type: 'schedule_remove', scheduleId });
  }
  broadcastGoalUpsert(goal: import('@solix/shared').Goal): void {
    this.broadcaster.broadcast({ type: 'goal_upsert', goal });
  }
  broadcastGoalRemove(goalId: string): void {
    this.broadcaster.broadcast({ type: 'goal_remove', goalId });
  }
  broadcastProjectUpsert(project: import('@solix/shared').Project): void {
    this.broadcaster.broadcast({ type: 'project_upsert', project });
  }
  broadcastAdvisorUpsert(advisor: import('@solix/shared').Advisor): void {
    this.broadcaster.broadcast({ type: 'advisor_upsert', advisor });
  }
  broadcastSkillUpsert(skill: import('@solix/shared').Skill): void {
    this.broadcaster.broadcast({ type: 'skill_upsert', skill });
  }
  broadcastSkillRemove(skillId: string): void {
    this.broadcaster.broadcast({ type: 'skill_remove', skillId });
  }
  // v2 Maestro — broadcast helpers for plan/task CRUD driven by HTTP + the
  // orchestrator.
  broadcastPlanUpsert(plan: import('@solix/shared').Plan): void {
    this.broadcaster.broadcast({ type: 'plan_upsert', plan });
  }
  broadcastPlanRemove(planId: string): void {
    this.broadcaster.broadcast({ type: 'plan_remove', planId });
  }
  broadcastPlanTaskUpsert(task: import('@solix/shared').PlanTask): void {
    this.broadcaster.broadcast({ type: 'plan_task_upsert', task });
  }
  broadcastPlanTaskRemove(taskId: string): void {
    this.broadcaster.broadcast({ type: 'plan_task_remove', taskId });
  }
  broadcastThreadEntry(
    entry: import('@solix/shared').TaskThreadEntry,
  ): void {
    this.broadcaster.broadcast({ type: 'thread_entry_append', entry });
  }

  broadcastGalaxyImported(manifest: GalaxyManifest): void {
    this.broadcaster.broadcast({ type: 'galaxy_imported', manifest });
    this.broadcaster.broadcast({
      type: 'toast',
      level: 'info',
      message: `Galaxy "${manifest.name}" imported`,
    });
    recordAudit(this.db, {
      kind: 'galaxy_imported',
      summary: `Imported galaxy "${manifest.name}"`,
      payload: {
        author: manifest.author,
        advisorCount: manifest.advisors.length,
        skillCount: manifest.skills.length,
        projectCount: manifest.projects.length,
      },
    });
  }

  setContextUsage(sessionId: string, pct: number): void {
    const session = setSessionContextUsage(this.db, sessionId, pct);
    if (session) {
      this.broadcaster.broadcast({
        type: 'context_update',
        sessionId,
        usagePct: session.contextUsagePct,
      });
    }
  }

  /**
   * Record spend and token usage against a session, the way a real assistant
   * message would.
   *
   * Cost normally arrives from the transcript watcher, which reads Claude
   * Code's JSONL and accrues per assistant message. `solix demo` has no
   * transcript to read, so without this it seeds a cost-governance product
   * with every number at zero — Mission Control showing $0.00 spend and
   * $0.00 per mission is the first thing a new user sees, and it hides the
   * one thing Solix is for.
   *
   * This mirrors the transcript path rather than writing the rows directly:
   * same cost accumulation, same mission-token roll-up, same `cost_update`
   * broadcast, same one-shot budget alert at the cap.
   */
  applyUsage(
    sessionId: string,
    usage: { costUsd?: number; tokens?: number; budgetUsd?: number },
  ): boolean {
    const session = getSession(this.db, sessionId);
    if (!session) return false;

    if (usage.budgetUsd != null) {
      setSessionBudget(this.db, sessionId, usage.budgetUsd);
    }

    // Tokens belong to the mission that is running now — which is why the
    // caller has to add them before the mission completes, exactly as a real
    // run does.
    if (usage.tokens && usage.tokens > 0 && session.currentMissionId) {
      addMissionTokens(this.db, session.currentMissionId, usage.tokens);
    }

    if (usage.costUsd == null) return true;

    const updated = setSessionCost(
      this.db,
      sessionId,
      session.costUsd + usage.costUsd,
    );
    const costUsd = updated?.costUsd ?? session.costUsd + usage.costUsd;
    const cap = updated?.budgetUsd ?? usage.budgetUsd ?? session.budgetUsd;
    this.broadcaster.broadcast({
      type: 'cost_update',
      sessionId,
      costUsd,
      budgetUsd: cap,
    });
    if (cap != null && costUsd >= cap) {
      this.broadcaster.broadcast({
        type: 'budget_alert',
        sessionId,
        costUsd,
        budgetUsd: cap,
      });
    }
    return true;
  }
}
