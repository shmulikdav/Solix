import { useEffect, useMemo, useState } from 'react';
import { useSolixStore } from '../store/index.js';

interface NewTaskModalProps {
  open: boolean;
  onClose: () => void;
}

// `value` is passed straight to Claude Code's --model. The lowercase tier
// aliases auto-resolve to the newest of each tier; the capitalized entries pin
// a specific model (they only launch if the user's Claude Code + plan support it).
const MODELS: { value: string; label: string }[] = [
  { value: 'default', label: 'default' },
  { value: 'opus', label: 'opus' },
  { value: 'sonnet', label: 'sonnet' },
  { value: 'haiku', label: 'haiku' },
  { value: 'claude-opus-5', label: 'Opus 5' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1' },
];

export function NewTaskModal({
  open,
  onClose,
}: NewTaskModalProps): JSX.Element | null {
  const projects = useSolixStore((s) => s.projects);
  const advisorsMap = useSolixStore((s) => s.advisors);
  const goalsMap = useSolixStore((s) => s.goals);
  const launchTask = useSolixStore((s) => s.launchTask);

  const projectList = Object.values(projects).sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt,
  );
  const enabledAdvisors = useMemo(
    () =>
      Object.values(advisorsMap)
        .filter((a) => a.enabled)
        .sort((a, b) => a.codename.localeCompare(b.codename)),
    [advisorsMap],
  );
  const [cwd, setCwd] = useState<string>('');
  const [model, setModel] = useState<string>('default');
  const [advisorId, setAdvisorId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [worktreeBranch, setWorktreeBranch] = useState('');
  const [worktreeBaseRef, setWorktreeBaseRef] = useState('');
  const [budget, setBudget] = useState('');
  const [goalId, setGoalId] = useState<string | null>(null);
  const goalList = Object.values(goalsMap);
  const [preflight, setPreflight] = useState<
    {
      claudeAvailable: boolean;
      version?: string;
      agentViewAvailable: boolean;
    } | null
  >(null);
  // When Agent View is available locally we default to dispatching
  // through it — the new session shows up in `claude agents` too.
  const [useAgentView, setUseAgentView] = useState(true);

  // Check whether `claude` is on the server's PATH so we can warn before
  // the user fills out the form. Cached server-side; safe to refetch.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/system/preflight')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setPreflight(d);
      })
      .catch(() => {
        /* offline; ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // When the modal opens (or when projects first arrive), default cwd to the
  // most recently active project so the user doesn't have to type a path.
  useEffect(() => {
    if (!open) return;
    if (cwd) return;
    const first = projectList[0];
    if (first) setCwd(first.cwd);
  }, [open, projectList, cwd]);

  if (!open) return null;

  const onLaunch = (): void => {
    const trimmedCwd = cwd.trim();
    const trimmedPrompt = prompt.trim();
    if (!trimmedCwd || !trimmedPrompt) return;
    const advisor = advisorId
      ? enabledAdvisors.find((a) => a.id === advisorId)
      : undefined;
    const finalPrompt = advisor
      ? `[Acting as ${advisor.codename} — ${advisor.name}. ${advisor.description}]\n\n${trimmedPrompt}`
      : trimmedPrompt;
    const finalModel =
      advisor && model === 'default' ? advisor.defaultModel : model;
    const trimmedBranch = worktreeBranch.trim();
    const dispatchViaAgentView =
      useAgentView && preflight?.agentViewAvailable === true;
    const budgetNum = parseFloat(budget);
    const budgetUsd = Number.isFinite(budgetNum) && budgetNum > 0 ? budgetNum : undefined;
    launchTask(trimmedCwd, finalModel, finalPrompt, {
      worktreeBranch: dispatchViaAgentView ? undefined : trimmedBranch || undefined,
      worktreeBaseRef: dispatchViaAgentView
        ? undefined
        : trimmedBranch
          ? worktreeBaseRef.trim() || undefined
          : undefined,
      useAgentView: dispatchViaAgentView,
      agentName: advisor?.codename.toLowerCase(),
      budgetUsd,
      goalId: goalId ?? undefined,
    });
    setPrompt('');
    setAdvisorId(null);
    setWorktreeBranch('');
    setWorktreeBaseRef('');
    setBudget('');
    setGoalId(null);
    onClose();
  };

  const onNewGoal = async (): Promise<void> => {
    const name = window.prompt('New goal name:');
    if (!name?.trim()) return;
    try {
      const res = await fetch('/api/goals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        const g = (await res.json()) as { id: string };
        setGoalId(g.id);
      }
    } catch {
      /* offline; ignore */
    }
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      {/*
        Dimmed, blurred backdrop as a SEPARATE layer behind the panel — NOT an
        ancestor of it. When the opaque panel was nested inside a
        `backdrop-blur` element, some browsers composited it translucently and
        the galaxy bled through the form. Keeping the blur on a sibling (the way
        SharePanel keeps it on its own element) makes the panel render solid.
      */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-lg" />
      <div className="relative z-10 w-[520px] max-w-[92vw] max-h-[88vh] flex flex-col rounded-xl border border-solix-accent/40 bg-solix-panel shadow-2xl">
        <div className="shrink-0 px-5 py-4 border-b border-solix-border flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-solix-accent">
              new task
            </div>
            <div className="text-lg font-semibold mt-0.5">
              Launch a Claude Code session
            </div>
            <div className="text-xs text-slate-400 mt-1">
              {preflight?.agentViewAvailable && useAgentView ? (
                <>
                  Dispatches via{' '}
                  <code className="bg-black/40 px-1 rounded">claude --bg</code>{' '}
                  — the session shows up in both Solix and{' '}
                  <code className="bg-black/40 px-1 rounded">claude agents</code>.
                </>
              ) : (
                <>
                  Solix will spawn <code className="bg-black/40 px-1 rounded">
                    claude --print
                  </code>{' '}
                  in this folder. A new planet appears the moment it starts.
                </>
              )}
            </div>
            {preflight && !preflight.claudeAvailable && (
              <div className="mt-2 text-[11px] text-solix-danger border border-solix-danger/40 bg-solix-danger/10 rounded px-2 py-1">
                <span className="font-semibold">claude</span> not found on the
                server's PATH. Install Claude Code, then restart the Solix
                server.
              </div>
            )}
            {preflight?.claudeAvailable && preflight.version && (
              <div className="mt-1 text-[10px] text-slate-500 font-mono">
                claude detected · {preflight.version}
                {preflight.agentViewAvailable && (
                  <>
                    {' '}
                    ·{' '}
                    <button
                      onClick={() => setUseAgentView((v) => !v)}
                      className={`underline decoration-dotted ${
                        useAgentView
                          ? 'text-solix-accent'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                      title="Toggle dispatch through Anthropic's Agent View"
                    >
                      {useAgentView ? 'agent view: on' : 'agent view: off'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          <label className="block">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">
              Working directory
            </div>
            {projectList.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {projectList.slice(0, 6).map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setCwd(p.cwd)}
                    className={`text-[10px] px-2 py-1 rounded border ${
                      cwd === p.cwd
                        ? 'bg-solix-accent/20 border-solix-accent text-solix-accent'
                        : 'border-solix-border text-slate-300 hover:bg-solix-border/30'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
            <input
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/you/path/to/project"
              className="w-full text-sm font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
            />
          </label>

          <label className="block">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">
              Model
            </div>
            <div className="flex flex-wrap gap-1.5">
              {MODELS.map((m) => (
                <button
                  key={m.value}
                  onClick={() => setModel(m.value)}
                  className={`text-xs px-3 py-1.5 rounded border ${
                    model === m.value
                      ? 'bg-solix-accent/20 border-solix-accent text-solix-accent'
                      : 'border-solix-border text-slate-300 hover:bg-solix-border/30'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </label>

          {enabledAdvisors.length > 0 && (
            <label className="block">
              <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">
                Advisor <span className="text-slate-600 normal-case">(optional)</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setAdvisorId(null)}
                  className={`text-xs px-3 py-1.5 rounded border ${
                    advisorId === null
                      ? 'bg-solix-accent/20 border-solix-accent text-solix-accent'
                      : 'border-solix-border text-slate-300 hover:bg-solix-border/30'
                  }`}
                >
                  none
                </button>
                {enabledAdvisors.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => setAdvisorId(a.id)}
                    title={a.description}
                    className={`text-xs px-3 py-1.5 rounded border flex items-center gap-1.5 ${
                      advisorId === a.id
                        ? 'border-amber-300 text-amber-100 bg-amber-500/15'
                        : 'border-solix-border text-slate-300 hover:bg-solix-border/30'
                    }`}
                  >
                    <span style={{ color: a.color }}>{a.glyph}</span>
                    {a.codename}
                  </button>
                ))}
              </div>
              {advisorId && (
                <div className="mt-1.5 text-[10px] text-slate-500 italic">
                  The advisor's role will be prepended to your prompt.
                </div>
              )}
            </label>
          )}

          <label className="block">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">
              Worktree branch{' '}
              <span className="text-slate-600 normal-case">(optional)</span>
            </div>
            <input
              value={worktreeBranch}
              onChange={(e) => setWorktreeBranch(e.target.value)}
              placeholder="leave empty to run in the chosen directory"
              className="w-full text-sm font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
            />
            {worktreeBranch.trim() && (
              <div className="mt-2 space-y-1">
                <div className="text-[10px] text-slate-500 italic">
                  Solix will create (or reuse) a fresh git worktree at
                  ~/.solix/worktrees/&lt;repo&gt;-{worktreeBranch.trim() || '<branch>'}
                  and spawn Claude there. Existing branches are reused.
                </div>
                <input
                  value={worktreeBaseRef}
                  onChange={(e) => setWorktreeBaseRef(e.target.value)}
                  placeholder="based on (default: HEAD)"
                  className="w-full text-xs font-mono bg-black/40 border border-solix-border rounded p-1.5 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
                />
              </div>
            )}
          </label>

          <div className="flex gap-3">
            <label className="block flex-1">
              <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">
                Budget{' '}
                <span className="text-slate-600 normal-case">(USD, optional)</span>
              </div>
              <input
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                inputMode="decimal"
                placeholder="e.g. 2.00"
                className="w-full text-sm font-mono bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent"
              />
            </label>
            <label className="block flex-1">
              <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">
                Goal{' '}
                <span className="text-slate-600 normal-case">(optional)</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <button
                  onClick={() => setGoalId(null)}
                  className={`text-xs px-2.5 py-1.5 rounded border ${
                    goalId === null
                      ? 'bg-solix-accent/20 border-solix-accent text-solix-accent'
                      : 'border-solix-border text-slate-300 hover:bg-solix-border/30'
                  }`}
                >
                  none
                </button>
                {goalList.map((g) => (
                  <button
                    key={g.id}
                    onClick={() => setGoalId(g.id)}
                    className={`text-xs px-2.5 py-1.5 rounded border flex items-center gap-1.5 ${
                      goalId === g.id
                        ? 'border-solix-accent text-slate-100 bg-solix-accent/15'
                        : 'border-solix-border text-slate-300 hover:bg-solix-border/30'
                    }`}
                  >
                    <span
                      className="inline-block w-2 h-2 rounded-full"
                      style={{ background: g.color }}
                    />
                    {g.name}
                  </button>
                ))}
                <button
                  onClick={onNewGoal}
                  className="text-xs px-2.5 py-1.5 rounded border border-dashed border-solix-border text-slate-400 hover:text-slate-100"
                >
                  + new
                </button>
              </div>
            </label>
          </div>

          <label className="block">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-1">
              Prompt
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onLaunch();
                }
              }}
              placeholder="What should this Claude Code session do?"
              rows={4}
              className="w-full text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent resize-none"
            />
          </label>
        </div>

        <div className="shrink-0 px-5 py-3 border-t border-solix-border flex items-center gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-solix-border text-xs text-slate-300 hover:text-white"
          >
            Cancel
          </button>
          <div className="flex-1" />
          <span className="text-[10px] text-slate-500 mr-2">
            Cmd/Ctrl+Enter
          </span>
          <button
            onClick={onLaunch}
            disabled={
              !cwd.trim() ||
              !prompt.trim() ||
              preflight?.claudeAvailable === false
            }
            className="px-4 py-1.5 rounded bg-solix-accent/20 border border-solix-accent text-solix-accent text-sm hover:bg-solix-accent/30 disabled:opacity-40"
          >
            Launch
          </button>
        </div>
      </div>
    </div>
  );
}
