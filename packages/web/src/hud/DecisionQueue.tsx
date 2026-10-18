import { useEffect, useRef, useState } from 'react';
import {
  selectPendingPermissionsOrdered,
  useSolixStore,
} from '../store/index.js';
import type { Mission, Session } from '@solix/shared';
import { suggestForPermission } from '../suggestions.js';

/**
 * Decision Queue — the "what do I need to do?" inbox.
 *
 * Always visible top-right, even when empty. Replaces the old
 * PermissionTray. Each pending permission becomes a card with:
 *   - which agent + which mission it belongs to
 *   - the tool + a one-line summary of the args
 *   - three actions: Approve (Y), Deny (N), Ask (opens chat)
 *
 * Sorted newest-first so the most recent block is at the top of the
 * queue.
 */
export function DecisionQueue({
  panelOffsetPx = 0,
}: {
  /** Width of the currently-open right-side panel, so the queue sits
   * beside it instead of overlapping. 0 when no panel is open. */
  panelOffsetPx?: number;
} = {}): JSX.Element {
  const pending = useSolixStore((s) => s.pendingPermissions);
  const budgetAlerts = useSolixStore((s) => s.budgetAlerts);
  const sessions = useSolixStore((s) => s.sessions);
  const missions = useSolixStore((s) => s.missions);
  const resolve = useSolixStore((s) => s.resolvePermission);
  const raiseBudget = useSolixStore((s) => s.raiseBudget);
  const dismissBudgetAlert = useSolixStore((s) => s.dismissBudgetAlert);
  const selectSession = useSolixStore((s) => s.selectSession);

  // Shared with the Y/N key handler in App.tsx — see
  // selectPendingPermissionsOrdered. Do not re-sort locally.
  const items = useSolixStore(selectPendingPermissionsOrdered);
  const alerts = Object.values(budgetAlerts).sort(
    (a, b) => b.receivedAt - a.receivedAt,
  );
  const [collapsed, setCollapsed] = useState(false);

  // Force-expand when something NEW arrives, so a pending decision is never
  // hidden. Deliberately only on an increase: the previous version fired on any
  // change while count > 0, so resolving one of three requests (3 → 2) also
  // re-expanded a queue the user had just collapsed, and there was no way to
  // keep it shut while work was in flight.
  const count = items.length + alerts.length;
  const prevCount = useRef(count);
  useEffect(() => {
    if (count > prevCount.current) setCollapsed(false);
    prevCount.current = count;
  }, [count]);

  const onAsk = (sessionId: string): void => {
    selectSession(sessionId);
    setCollapsed(true);
  };

  // When the queue is empty, collapse to a single quiet strip — no need
  // for a separate "All clear" panel taking real estate when nothing's
  // waiting on the user.
  if (count === 0) {
    return (
      <div
        className="absolute top-20 z-30 pointer-events-none"
        style={{ right: `${panelOffsetPx + 16}px` }}
      >
        <div className="pointer-events-auto rounded-full border border-solix-border bg-solix-panel/60 backdrop-blur px-3 py-1 text-[10px] text-slate-500 flex items-center gap-2">
          <span className="uppercase tracking-widest">decisions</span>
          <span className="font-bold">0</span>
          <span className="italic opacity-80">— all clear</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="absolute top-20 z-30 w-80 flex flex-col gap-2 pointer-events-none"
      style={{ right: `${panelOffsetPx + 16}px` }}
    >
      <div className="pointer-events-auto rounded border border-solix-border bg-solix-panel/85 backdrop-blur px-3 py-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-slate-400">
            Decisions
          </span>
          <span className="text-xs font-bold text-solix-danger">{count}</span>
        </div>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-[10px] text-slate-400 hover:text-slate-100"
        >
          {collapsed ? 'show' : 'hide'}
        </button>
      </div>

      {!collapsed &&
        alerts.map((a) => (
          <BudgetCard
            key={`budget-${a.sessionId}`}
            name={
              sessions[a.sessionId]?.name ?? a.sessionId.slice(0, 8)
            }
            costUsd={a.costUsd}
            budgetUsd={a.budgetUsd}
            onRaise={() => {
              const next = window.prompt(
                `New budget cap (USD) for this agent — current $${a.budgetUsd.toFixed(2)}, spent $${a.costUsd.toFixed(2)}:`,
                (a.budgetUsd * 2).toFixed(2),
              );
              const n = next ? parseFloat(next) : NaN;
              if (Number.isFinite(n) && n > 0) raiseBudget(a.sessionId, n);
            }}
            onDismiss={() => dismissBudgetAlert(a.sessionId)}
          />
        ))}

      {!collapsed &&
        items.map((p) => {
          const session = sessions[p.sessionId];
          const mission =
            session?.currentMissionId
              ? missions[session.currentMissionId]
              : undefined;
          return (
            <DecisionCard
              key={p.requestId}
              session={session}
              mission={mission}
              tool={p.tool}
              args={p.args}
              onApprove={() => resolve(p.requestId, true)}
              onDeny={() => resolve(p.requestId, false)}
              onAsk={() => onAsk(p.sessionId)}
            />
          );
        })}
    </div>
  );
}

function BudgetCard({
  name,
  costUsd,
  budgetUsd,
  onRaise,
  onDismiss,
}: {
  name: string;
  costUsd: number;
  budgetUsd: number;
  onRaise: () => void;
  onDismiss: () => void;
}): JSX.Element {
  return (
    <div className="pointer-events-auto rounded border border-solix-danger bg-solix-panel p-3 backdrop-blur shadow-lg">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-solix-danger">
          {name}
        </div>
        <div className="text-[10px] uppercase tracking-widest text-solix-danger/80">
          budget
        </div>
      </div>
      <div className="mt-2 text-sm text-slate-100">
        Budget reached
        <span className="ml-1 font-mono text-xs text-slate-300">
          ${costUsd.toFixed(2)} / ${budgetUsd.toFixed(2)}
        </span>
      </div>
      <div className="mt-1 text-[11px] text-slate-400 leading-snug">
        Solix-launched agents won't be sent more prompts until you raise the cap.
      </div>
      <div className="mt-3 flex gap-1.5">
        <button
          onClick={onRaise}
          className="flex-1 py-1.5 rounded bg-solix-ok/20 border border-solix-ok text-solix-ok text-xs hover:bg-solix-ok/30"
        >
          Raise cap
        </button>
        <button
          onClick={onDismiss}
          className="px-2.5 py-1.5 rounded border border-solix-border text-slate-300 text-xs hover:text-white hover:bg-solix-border/30"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

interface DecisionCardProps {
  session: Session | undefined;
  mission: Mission | undefined;
  tool: string;
  args: Record<string, unknown>;
  onApprove: () => void;
  onDeny: () => void;
  onAsk: () => void;
}

function DecisionCard({
  session,
  mission,
  tool,
  args,
  onApprove,
  onDeny,
  onAsk,
}: DecisionCardProps): JSX.Element {
  const name =
    session?.name ?? session?.id.slice(0, 8) ?? 'unknown agent';
  const project = session?.cwd ? basename(session.cwd) : '';
  const suggestion = session
    ? suggestForPermission(session, mission, tool, args)
    : null;

  return (
    <div className="pointer-events-auto rounded border border-solix-danger bg-solix-panel p-3 backdrop-blur shadow-lg">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-solix-danger">
          {name}
        </div>
        {project && (
          <div className="text-[10px] text-slate-500 truncate ml-2 max-w-[55%]">
            {project}
          </div>
        )}
      </div>

      {mission && (
        <div className="mt-1 text-[11px] text-slate-400 italic truncate">
          mission: {mission.shortName}
        </div>
      )}

      <div className="mt-2 text-sm text-slate-100">
        <span className="font-semibold">{tool}</span>
        <span className="ml-1 text-slate-300 text-xs break-words">
          {summarizeArgs(args)}
        </span>
      </div>

      <PermissionPreview tool={tool} args={args} />

      {suggestion && <SuggestionLine suggestion={suggestion} />}

      <div className="mt-3 flex gap-1.5">
        <button
          onClick={onApprove}
          className="flex-1 py-1.5 rounded bg-solix-ok/20 border border-solix-ok text-solix-ok text-xs hover:bg-solix-ok/30"
        >
          Approve · Y
        </button>
        <button
          onClick={onDeny}
          className="flex-1 py-1.5 rounded bg-solix-danger/20 border border-solix-danger text-solix-danger text-xs hover:bg-solix-danger/30"
        >
          Deny · N
        </button>
        <button
          onClick={onAsk}
          className="px-2.5 py-1.5 rounded border border-solix-border text-slate-300 text-xs hover:text-white hover:bg-solix-border/30"
          title="Open chat with this agent for context"
        >
          Ask
        </button>
      </div>
    </div>
  );
}

/**
 * Inline preview that turns "approve this opaque tool call" into "here's
 * exactly what's about to happen." Shape varies by tool:
 *   - Bash: the full command, monospace
 *   - Edit / Write / NotebookEdit: file path + a short before/after window
 *   - Read / Glob / Grep: the path or pattern
 * Returns null for tools where the one-line args summary already says it.
 */
function PermissionPreview({
  tool,
  args,
}: {
  tool: string;
  args: Record<string, unknown>;
}): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);

  if (tool === 'Bash') {
    const cmd = strArg(args, 'command') ?? '';
    const desc = strArg(args, 'description');
    if (!cmd) return null;
    return (
      <PreviewShell label="will run">
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] text-slate-100">
          {cmd}
        </pre>
        {desc && (
          <div className="mt-1 text-[10px] text-slate-500 italic">
            {desc}
          </div>
        )}
      </PreviewShell>
    );
  }

  if (tool === 'Edit' || tool === 'NotebookEdit') {
    const path = strArg(args, 'file_path') ?? strArg(args, 'notebook_path');
    const oldStr = strArg(args, 'old_string');
    const newStr = strArg(args, 'new_string');
    if (!path && !oldStr && !newStr) return null;
    return (
      <PreviewShell label="patch">
        {path && (
          <div className="font-mono text-[11px] text-solix-accent break-all">
            {path}
          </div>
        )}
        {oldStr && (
          <DiffSnippet
            sign="-"
            text={oldStr}
            expanded={expanded}
            colorClass="text-solix-danger bg-solix-danger/10"
          />
        )}
        {newStr && (
          <DiffSnippet
            sign="+"
            text={newStr}
            expanded={expanded}
            colorClass="text-solix-ok bg-solix-ok/10"
          />
        )}
        {(longish(oldStr) || longish(newStr)) && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[10px] text-slate-400 hover:text-slate-100"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        )}
      </PreviewShell>
    );
  }

  if (tool === 'Write') {
    const path = strArg(args, 'file_path');
    const content = strArg(args, 'content') ?? '';
    if (!path) return null;
    return (
      <PreviewShell label="will write">
        <div className="font-mono text-[11px] text-solix-accent break-all">
          {path}
        </div>
        {content && (
          <DiffSnippet
            sign="+"
            text={content}
            expanded={expanded}
            colorClass="text-solix-ok bg-solix-ok/10"
          />
        )}
        {longish(content) && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[10px] text-slate-400 hover:text-slate-100"
          >
            {expanded ? 'collapse' : 'expand'}
          </button>
        )}
      </PreviewShell>
    );
  }

  return null;
}

function PreviewShell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="mt-2 rounded border border-solix-border bg-black/30 px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-slate-500 mb-1">
        {label}
      </div>
      {children}
    </div>
  );
}

function DiffSnippet({
  sign,
  text,
  expanded,
  colorClass,
}: {
  sign: '+' | '-';
  text: string;
  expanded: boolean;
  colorClass: string;
}): JSX.Element {
  const shown = expanded ? text : truncateMiddle(text, 240);
  return (
    <pre
      className={`mt-1 px-1.5 py-1 rounded text-[11px] font-mono whitespace-pre-wrap break-words ${colorClass}`}
    >
      <span className="opacity-50 mr-1">{sign}</span>
      {shown}
    </pre>
  );
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' ? v : undefined;
}

function longish(s: string | undefined): boolean {
  return Boolean(s && s.length > 240);
}

function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor((max - 3) / 2);
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}

function SuggestionLine({
  suggestion,
}: {
  suggestion: { text: string; severity: 'info' | 'warn' | 'danger' };
}): JSX.Element {
  const colorClass =
    suggestion.severity === 'danger'
      ? 'text-solix-danger border-solix-danger/40 bg-solix-danger/10'
      : suggestion.severity === 'warn'
        ? 'text-solix-warn border-solix-warn/40 bg-solix-warn/10'
        : 'text-slate-300 border-solix-border bg-black/20';
  return (
    <div
      className={`mt-2 px-2 py-1 rounded border text-[11px] leading-snug ${colorClass}`}
    >
      <span className="font-semibold mr-1">Suggested:</span>
      {suggestion.text}
    </div>
  );
}

function basename(p: string): string {
  const m = p.match(/[^/\\]+\/?$/);
  return m ? m[0].replace(/\/$/, '') : p;
}

function summarizeArgs(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  if (!keys.length) return '';
  const summarized = keys.slice(0, 2).map((k) => {
    const v = args[k];
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}=${s.length > 40 ? s.slice(0, 40) + '…' : s}`;
  });
  return summarized.join(' · ');
}
