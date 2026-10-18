import { useEffect, useMemo, useRef, useState } from 'react';
import { useSolixStore } from '../store/index.js';
import { statusLabel } from '../scene/colors.js';
import { suggestForSession } from '../suggestions.js';
import { GLOSSARY } from '../glossary.js';
import { RightDock, TabButton } from './RightDock.js';

type Tab = 'chat' | 'missions' | 'files';

export function SidePanel(): JSX.Element | null {
  const selectedId = useSolixStore((s) => s.selectedSessionId);
  const sessions = useSolixStore((s) => s.sessions);
  const goals = useSolixStore((s) => s.goals);
  const missions = useSolixStore((s) => s.missions);
  const chatBySessionId = useSolixStore((s) => s.chatBySessionId);
  const selectSession = useSolixStore((s) => s.selectSession);
  const sendPromptTo = useSolixStore((s) => s.sendPromptTo);

  const [tab, setTab] = useState<Tab>('chat');
  const [composer, setComposer] = useState('');
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const session = selectedId ? sessions[selectedId] : null;
  const chat = useMemo(
    () => (selectedId ? (chatBySessionId[selectedId] ?? []) : []),
    [chatBySessionId, selectedId],
  );
  const sessionMissions = useMemo(() => {
    if (!session) return [];
    return Object.values(missions)
      .filter((m) => m.sessionId === session.id)
      .sort((a, b) => b.startedAt - a.startedAt);
  }, [missions, session]);

  const currentMission = useMemo(() => {
    if (!session?.currentMissionId) return undefined;
    return missions[session.currentMissionId];
  }, [missions, session]);
  const sessionSuggestion = session
    ? suggestForSession(session, currentMission)
    : null;

  // Auto-scroll chat to the newest message whenever it grows.
  useEffect(() => {
    if (tab !== 'chat') return;
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [tab, chat.length, selectedId]);

  if (!session) return null;

  const isInternal = session.origin === 'internal';
  // Sprint J: external sessions started via `solix run` have a wrapper
  // Unix socket the server can write to. From the UI's perspective,
  // they're functionally equivalent to internal sessions for the
  // composer — we ship prompts via sendPromptToSession either way.
  const isWrapped = Boolean(session.wrapperSocketPath);
  const composerEnabled = isInternal || isWrapped;
  const goal = session.currentGoalId ? goals[session.currentGoalId] : undefined;
  const budgetPct =
    session.budgetUsd && session.budgetUsd > 0
      ? Math.min(100, (session.costUsd / session.budgetUsd) * 100)
      : null;

  const onSend = (): void => {
    if (!composer.trim()) return;
    sendPromptTo(session.id, composer);
    setComposer('');
  };

  return (
    <RightDock layer="contextual">
      <div className="px-4 py-3 border-b border-solix-border flex items-start justify-between">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-slate-400">
            Planet
          </div>
          <div className="text-lg font-semibold truncate">
            {session.name ?? session.id.slice(0, 8)}
          </div>
          <div
            className="text-xs text-slate-400 mt-0.5 truncate"
            title={GLOSSARY[session.status] ?? undefined}
          >
            {String(session.model)} · {statusLabel(session.status)}
            {session.origin === 'external'
              ? ' · external'
              : session.origin === 'agentview'
                ? ' · agent view'
                : ' · internal'}
            {isWrapped && (
              <span
                className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wide border border-solix-accent/50 text-solix-accent"
                title="Wrapped by `solix run` — UI prompts go to your terminal."
              >
                wrapped
              </span>
            )}
            {session.agentViewId && (
              <span
                className="ml-1.5 font-mono text-[9px] text-cyan-300/80"
                title={`Agent View id: ${session.agentViewId}`}
              >
                {session.agentViewId.slice(0, 8)}
              </span>
            )}
          </div>
          {session.prUrl && (
            <a
              href={session.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-slate-300 hover:text-white border border-solix-border rounded px-2 py-0.5"
              title={`Open ${session.prUrl}`}
            >
              <span>PR</span>
              <span className="text-slate-500 truncate max-w-[200px]">
                {session.prUrl.replace(/^https?:\/\//, '')}
              </span>
              {session.prCheckStatus && (
                <span
                  className={
                    session.prCheckStatus === 'success'
                      ? 'text-solix-ok'
                      : session.prCheckStatus === 'failure'
                        ? 'text-solix-danger'
                        : 'text-amber-300'
                  }
                >
                  {session.prCheckStatus === 'success'
                    ? '✓'
                    : session.prCheckStatus === 'failure'
                      ? '✗'
                      : '⏳'}
                </span>
              )}
            </a>
          )}
          {session.agentViewSummary && (
            <div
              className="mt-1 text-[11px] text-slate-400 italic line-clamp-2"
              title={session.agentViewSummary}
            >
              {session.agentViewSummary}
            </div>
          )}
          {goal && (
            <div className="mt-1 inline-flex items-center gap-1.5 text-[11px]">
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: goal.color }}
              />
              <span className="text-slate-300">{goal.name}</span>
            </div>
          )}
          {(session.budgetUsd != null || session.costUsd > 0) && (
            <div className="mt-1.5">
              <div className="flex items-center justify-between text-[11px] text-slate-400">
                <span>cost</span>
                <span className="font-mono">
                  ${session.costUsd.toFixed(2)}
                  {session.budgetUsd != null && (
                    <span className="text-slate-500">
                      {' '}
                      / ${session.budgetUsd.toFixed(2)}
                    </span>
                  )}
                </span>
              </div>
              {budgetPct != null && (
                <div className="mt-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full"
                    style={{
                      width: `${budgetPct}%`,
                      background:
                        budgetPct >= 100
                          ? '#dc2626'
                          : budgetPct >= 75
                            ? '#f59e0b'
                            : '#38bdf8',
                    }}
                  />
                </div>
              )}
            </div>
          )}
        </div>
        <button
          onClick={() => selectSession(null)}
          className="text-slate-400 hover:text-slate-100"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      {sessionSuggestion && (
        <div
          className={`px-4 py-2 border-b border-solix-border text-[11px] leading-snug ${
            sessionSuggestion.severity === 'danger'
              ? 'text-solix-danger bg-solix-danger/10'
              : sessionSuggestion.severity === 'warn'
                ? 'text-solix-warn bg-solix-warn/10'
                : 'text-slate-300 bg-black/20'
          }`}
        >
          <span className="font-semibold mr-1">Suggested:</span>
          {sessionSuggestion.text}
        </div>
      )}

      <div className="px-4 py-2 border-b border-solix-border">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>context</span>
          <span>{session.contextUsagePct.toFixed(0)}%</span>
        </div>
        <div className="mt-1 h-1.5 rounded-full bg-slate-800 overflow-hidden">
          <div
            className={`h-full ${
              session.contextUsagePct >= 90
                ? 'bg-solix-danger'
                : session.contextUsagePct >= 80
                  ? 'bg-solix-warn'
                  : 'bg-solix-accent'
            }`}
            style={{ width: `${Math.min(100, session.contextUsagePct)}%` }}
          />
        </div>
      </div>

      <div className="flex border-b border-solix-border text-xs">
        <TabButton active={tab === 'chat'} onClick={() => setTab('chat')}>
          Chat {chat.length > 0 && <span className="opacity-60">({chat.length})</span>}
        </TabButton>
        <TabButton
          active={tab === 'missions'}
          onClick={() => setTab('missions')}
        >
          Missions {sessionMissions.length > 0 && <span className="opacity-60">({sessionMissions.length})</span>}
        </TabButton>
        <TabButton active={tab === 'files'} onClick={() => setTab('files')}>
          Files
        </TabButton>
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === 'chat' && (
          <ChatTab chat={chat} scrollRef={chatScrollRef} session={session} />
        )}
        {tab === 'missions' && <MissionsTab missions={sessionMissions} />}
        {tab === 'files' && <FilesTab missions={sessionMissions} />}
      </div>

      {tab === 'chat' && (
        <div className="px-3 py-3 border-t border-solix-border">
          {composerEnabled ? (
            <>
              <div className="flex gap-2">
                <textarea
                  value={composer}
                  onChange={(e) => setComposer(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      onSend();
                    }
                  }}
                  placeholder={
                    isWrapped
                      ? 'Type a prompt — it goes straight into your terminal claude (Cmd/Ctrl+Enter)'
                      : 'Send a prompt to this session… (Cmd/Ctrl+Enter)'
                  }
                  rows={2}
                  className="flex-1 text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent resize-none"
                />
                <button
                  onClick={onSend}
                  disabled={!composer.trim()}
                  className="px-3 py-2 rounded bg-solix-accent/20 border border-solix-accent text-solix-accent text-sm hover:bg-solix-accent/30 disabled:opacity-40"
                >
                  Send
                </button>
              </div>
              {isWrapped && (
                <div className="text-[10px] text-slate-500 italic mt-1.5">
                  Wrapped by <code>solix run</code>. Don't type in the terminal
                  while sending from here, or characters will interleave.
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-slate-500">
              External session — keep typing in your terminal. To send prompts
              from here instead, restart the session with{' '}
              <code className="bg-black/40 px-1 rounded">solix run</code>.
            </div>
          )}
        </div>
      )}
    </RightDock>
  );
}

function ChatTab({
  chat,
  scrollRef,
  session,
}: {
  chat: { messageId: string; role: string; content: string; ts: number }[];
  scrollRef: React.RefObject<HTMLDivElement>;
  session: { id: string; cwd: string };
}): JSX.Element {
  return (
    <div ref={scrollRef} className="h-full overflow-y-auto p-4 space-y-3">
      {chat.length === 0 && (
        <div className="text-sm text-slate-500 italic">
          No chat yet. Type a prompt to this session in your terminal — it will
          stream here as it happens.
          <div className="mt-2 text-[11px] text-slate-600">
            Watching transcript at <code>~/.claude/projects/{`<encoded>`}/{session.id}.jsonl</code>
          </div>
        </div>
      )}
      {chat.map((m) => (
        <div
          key={m.messageId}
          className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
          <div
            className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
              m.role === 'user'
                ? 'bg-solix-accent/15 border border-solix-accent/40 text-slate-100'
                : 'bg-black/40 border border-solix-border text-slate-200'
            }`}
          >
            <div className="text-[10px] uppercase tracking-wide opacity-60 mb-1">
              {m.role}
              <span className="ml-2 text-slate-500">
                {new Date(m.ts).toLocaleTimeString()}
              </span>
            </div>
            <div className="whitespace-pre-wrap break-words leading-relaxed">
              {m.content}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface MissionLite {
  id: string;
  shortName: string;
  prompt: string;
  status: string;
  startedAt: number;
  metrics: { toolCallCount: number; subagentCount: number; durationMs?: number };
  filesTouched: string[];
}

function MissionsTab({ missions }: { missions: MissionLite[] }): JSX.Element {
  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      {missions.length === 0 ? (
        <div className="text-sm text-slate-500 italic">No missions yet.</div>
      ) : (
        missions.map((m) => (
          <div
            key={m.id}
            className="rounded border border-solix-border p-3 bg-black/30"
          >
            <div className="flex items-center justify-between text-xs">
              <span
                className={`font-semibold ${
                  m.status === 'active'
                    ? 'text-solix-warn'
                    : m.status === 'completed'
                      ? 'text-solix-ok'
                      : 'text-slate-300'
                }`}
              >
                {m.shortName}
              </span>
              <span className="text-slate-500">
                {new Date(m.startedAt).toLocaleTimeString()}
              </span>
            </div>
            <div className="mt-1 text-sm text-slate-200 line-clamp-3">
              {m.prompt}
            </div>
            <div className="mt-2 flex gap-3 text-[10px] text-slate-500">
              <span>{m.metrics.toolCallCount} tools</span>
              <span>{m.metrics.subagentCount} subagents</span>
              <span>{m.filesTouched.length} files</span>
              {m.metrics.durationMs !== undefined && (
                <span>{(m.metrics.durationMs / 1000).toFixed(1)}s</span>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function FilesTab({ missions }: { missions: MissionLite[] }): JSX.Element {
  const files = Array.from(
    new Set(missions.flatMap((m) => m.filesTouched)),
  ).sort();
  return (
    <div className="h-full overflow-y-auto p-4">
      {files.length === 0 ? (
        <div className="text-sm text-slate-500 italic">
          No files touched yet.
        </div>
      ) : (
        <ul className="space-y-1 text-xs font-mono text-slate-300">
          {files.map((f) => (
            <li key={f} className="truncate">
              {f}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
