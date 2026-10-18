import { useEffect, useState } from 'react';
import { useSolixStore } from '../store/index.js';
import { RightDock } from './RightDock.js';
import { Button } from '../ui/Button.js';

interface EnvelopePreview {
  prompt: string;
  recentMissionsCount: number;
  contextUsagePct: number | null;
}

export function AdvisorPanel(): JSX.Element | null {
  const advisorId = useSolixStore((s) => s.selectedAdvisorId);
  const advisor = useSolixStore((s) =>
    advisorId ? s.advisors[advisorId] : null,
  );
  const targetSession = useSolixStore((s) =>
    s.selectedSessionId ? s.sessions[s.selectedSessionId] : null,
  );
  const select = useSolixStore((s) => s.selectAdvisor);
  const invokeAdvisor = useSolixStore((s) => s.invokeAdvisor);
  const pinAdvisor = useSolixStore((s) => s.pinAdvisor);
  const unpinAdvisor = useSolixStore((s) => s.unpinAdvisor);
  const enableAdvisor = useSolixStore((s) => s.enableAdvisor);
  const disableAdvisor = useSolixStore((s) => s.disableAdvisor);

  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<EnvelopePreview | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    if (!advisor) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const params = new URLSearchParams();
    if (targetSession) params.set('targetSessionId', targetSession.id);
    if (prompt.trim()) params.set('prompt', prompt.trim());
    const qs = params.toString();
    fetch(
      `/api/advisors/${encodeURIComponent(advisor.id)}/preview${qs ? `?${qs}` : ''}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((d: EnvelopePreview | null) => {
        if (!cancelled) setPreview(d);
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [advisor?.id, targetSession?.id, prompt]);

  if (!advisor) return null;

  const onInvoke = (): void => {
    invokeAdvisor(advisor.id, prompt.trim() || undefined);
    setPrompt('');
  };

  return (
    <RightDock layer="contextual">
      <div className="px-4 py-3 border-b border-solix-border flex items-start justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-amber-200/70">
            Advisor
          </div>
          <div className="text-lg font-semibold flex items-center gap-2">
            <span style={{ color: advisor.color }}>{advisor.glyph}</span>
            <span>{advisor.codename}</span>
            {advisor.pinned && (
              <span className="text-[10px] uppercase tracking-wider text-amber-300 border border-amber-300/40 rounded px-1.5 py-0.5">
                pinned
              </span>
            )}
            {!advisor.enabled && (
              <span className="text-[10px] uppercase tracking-wider text-cyan-300 border border-cyan-300/40 rounded px-1.5 py-0.5">
                opt-in
              </span>
            )}
          </div>
          <div className="text-xs text-slate-400 mt-0.5">
            {advisor.name} · {String(advisor.defaultModel)}
          </div>
        </div>
        <button
          onClick={() => select(null)}
          className="text-slate-400 hover:text-slate-100"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="px-4 py-3 border-b border-solix-border text-sm text-slate-300 leading-relaxed">
        {advisor.description}
      </div>

      {advisor.requiredSkills.length > 0 && (
        <div className="px-4 py-2 border-b border-solix-border">
          <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">
            requires skills
          </div>
          <div className="flex flex-wrap gap-1.5">
            {advisor.requiredSkills.map((s) => (
              <span
                key={s}
                className="text-[10px] px-1.5 py-0.5 rounded bg-solix-accent/15 border border-solix-accent/40 text-solix-accent"
              >
                {s}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm text-slate-300">
        <div className="text-xs uppercase tracking-wide text-slate-400">
          Invoke
        </div>
        <div className="text-xs text-slate-500">
          {targetSession ? (
            <>
              Will dispatch to{' '}
              <span className="text-slate-200">
                {targetSession.name ?? targetSession.id.slice(0, 8)}
              </span>{' '}
              <span className="text-slate-500">({targetSession.cwd})</span>
            </>
          ) : (
            <>No planet focused. Click a user planet first to set a target.</>
          )}
        </div>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`Optional: hand ${advisor.codename} a specific brief…`}
          rows={4}
          className="w-full text-sm bg-black/40 border border-solix-border rounded p-2 text-slate-100 placeholder-slate-600 focus:outline-none focus:border-solix-accent resize-none"
        />

        {preview && (
          <div className="rounded border border-solix-border bg-black/30">
            <button
              onClick={() => setShowPreview((v) => !v)}
              className="w-full text-left px-2 py-1.5 text-xs flex items-center justify-between text-slate-400 hover:text-slate-100"
            >
              <span>
                Context pressure · {preview.recentMissionsCount} mission(s)
                {preview.contextUsagePct !== null &&
                  ` · target at ${preview.contextUsagePct.toFixed(0)}%`}
              </span>
              <span>{showPreview ? '▾' : '▸'}</span>
            </button>
            {showPreview && (
              <pre className="text-[10.5px] text-slate-300 whitespace-pre-wrap px-3 pb-3 max-h-72 overflow-auto leading-relaxed">
                {preview.prompt}
              </pre>
            )}
          </div>
        )}
      </div>

      {!advisor.enabled ? (
        <div className="px-4 py-3 border-t border-solix-border flex flex-col gap-2">
          <button
            onClick={() => enableAdvisor(advisor.id)}
            className="w-full py-2 rounded bg-solix-warn/20 border border-solix-warn/60 text-solix-warn text-sm hover:bg-solix-warn/30"
            title="Add this advisor to your crew (renders in the inner ring, selectable in + Task)"
          >
            ＋ Add to crew
          </button>
          <Button variant="ghost" block onClick={onInvoke}>
            Invoke once without adding
          </Button>
        </div>
      ) : (
        <div className="px-4 py-3 border-t border-solix-border flex gap-2">
          <Button variant="warn" onClick={onInvoke} className="flex-1">
            Invoke
          </Button>
          {advisor.pinned ? (
            <Button variant="warn" onClick={() => unpinAdvisor(advisor.id)}>
              Unpin
            </Button>
          ) : (
            <Button
              variant="warn"
              onClick={() => pinAdvisor(advisor.id)}
              title="Spawn an always-on session for this advisor"
            >
              Pin
            </Button>
          )}
          <Button
            variant="ghost"
            onClick={() => disableAdvisor(advisor.id)}
            title="Remove from crew (keeps it available as opt-in)"
          >
            Disable
          </Button>
        </div>
      )}
    </RightDock>
  );
}
