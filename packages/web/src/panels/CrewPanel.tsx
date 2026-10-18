import { useEffect } from 'react';
import type { Advisor, Session } from '@solix/shared';
import { selectAllAdvisors, useSolixStore } from '../store/index.js';

interface CrewPanelProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Sprint N — the crew roster. Lists every advisor (active + opt-in) so users
 * can discover and enable the ones that ship disabled. Mirrors the
 * SharePanel open/close pattern; opened from the TopBar "✦ Crew" button.
 */
export function CrewPanel({ open, onClose }: CrewPanelProps): JSX.Element | null {
  const advisors = useSolixStore(selectAllAdvisors);
  const enableAdvisor = useSolixStore((s) => s.enableAdvisor);
  const disableAdvisor = useSolixStore((s) => s.disableAdvisor);
  const pinAdvisor = useSolixStore((s) => s.pinAdvisor);
  const unpinAdvisor = useSolixStore((s) => s.unpinAdvisor);
  const selectAdvisor = useSolixStore((s) => s.selectAdvisor);
  // For per-advisor cost transparency: a pinned advisor runs an always-on
  // session, so we surface that session's live spend on its card.
  const sessions = useSolixStore((s) => s.sessions);

  // Self-heal the advisor list when the panel opens. If the WS snapshot
  // arrived empty (server hadn't seeded yet, race on reconnect, stale
  // socket), the Zustand cache stays empty until something *changes* an
  // advisor — which the user can't trigger because they see nothing to
  // click. Re-reading from /api/advisors on open guarantees the panel is
  // populated within ~200ms regardless of WS state. Same pattern as
  // NewTaskModal's /api/system/preflight fetch.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/advisors')
      .then((r) => (r.ok ? (r.json() as Promise<Advisor[]>) : []))
      .then((list) => {
        if (cancelled) return;
        const { applyMessage } = useSolixStore.getState();
        for (const a of list) {
          applyMessage({ type: 'advisor_upsert', advisor: a });
        }
      })
      .catch(() => {
        /* offline; render whatever the store already has */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const active = advisors.filter((a) => a.enabled);
  const optIn = advisors.filter((a) => !a.enabled);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center">
      {/* Blurred backdrop as a sibling, not an ancestor of the opaque panel —
          see NewTaskModal for why (backdrop-filter compositing bleed-through). */}
      <div className="absolute inset-0 bg-black/80 backdrop-blur-lg" />
      <div className="relative z-10 w-[620px] max-w-[94vw] max-h-[88vh] flex flex-col rounded-xl border border-solix-accent/40 bg-solix-panel shadow-2xl">
        <div className="px-5 py-4 border-b border-solix-border flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-solix-accent">
              crew
            </div>
            <div className="text-lg font-semibold mt-0.5">Advisor roster</div>
            <div className="text-xs text-slate-400 mt-1">
              {active.length} active · {optIn.length} available. Enable an
              advisor to add it to the inner ring and the + Task picker.
            </div>
            <div className="text-[11px] text-slate-500 mt-1 leading-snug">
              <span className="text-solix-ok">Enabling is free</span> — no API
              calls. An advisor costs tokens only when you{' '}
              <span className="text-amber-300">pin</span> it (an always-on
              session) or invoke it on a task.
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          <CrewSection
            title={`Active crew · ${active.length}`}
            advisors={active}
            sessions={sessions}
            enableAdvisor={enableAdvisor}
            disableAdvisor={disableAdvisor}
            pinAdvisor={pinAdvisor}
            unpinAdvisor={unpinAdvisor}
            selectAdvisor={selectAdvisor}
            onClose={onClose}
          />
          {optIn.length > 0 && (
            <CrewSection
              title={`Available (opt-in) · ${optIn.length}`}
              advisors={optIn}
              sessions={sessions}
              enableAdvisor={enableAdvisor}
              disableAdvisor={disableAdvisor}
              pinAdvisor={pinAdvisor}
              unpinAdvisor={unpinAdvisor}
              selectAdvisor={selectAdvisor}
              onClose={onClose}
            />
          )}
        </div>
      </div>
    </div>
  );
}

interface CrewSectionProps {
  title: string;
  advisors: Advisor[];
  sessions: Record<string, Session>;
  enableAdvisor: (id: string) => void;
  disableAdvisor: (id: string) => void;
  pinAdvisor: (id: string) => void;
  unpinAdvisor: (id: string) => void;
  selectAdvisor: (id: string | null) => void;
  onClose: () => void;
}

function CrewSection({
  title,
  advisors,
  sessions,
  enableAdvisor,
  disableAdvisor,
  pinAdvisor,
  unpinAdvisor,
  selectAdvisor,
  onClose,
}: CrewSectionProps): JSX.Element {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
        {title}
      </div>
      <div className="space-y-2">
        {advisors.map((a) => (
          <div
            key={a.id}
            className="rounded border border-solix-border bg-black/20 p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span style={{ color: a.color }}>{a.glyph}</span>
                  <span className="font-semibold text-slate-100">
                    {a.codename}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    {a.name} · {String(a.defaultModel)}
                  </span>
                  {a.pinned ? (
                    <span
                      className="text-[9px] uppercase tracking-wider text-amber-300 border border-amber-300/40 rounded px-1 py-0.5"
                      title="Always-on session — this is where an advisor costs tokens."
                    >
                      pinned
                      {a.pinnedSessionId &&
                      sessions[a.pinnedSessionId] != null
                        ? ` · $${sessions[a.pinnedSessionId]!.costUsd.toFixed(2)}`
                        : ''}
                    </span>
                  ) : (
                    a.enabled && (
                      <span
                        className="text-[9px] uppercase tracking-wider text-solix-ok/80 border border-solix-ok/30 rounded px-1 py-0.5"
                        title="Enabled advisors make no API calls until pinned or invoked."
                      >
                        free
                      </span>
                    )
                  )}
                </div>
                <div className="mt-1 text-xs text-slate-400 leading-snug">
                  {a.description}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 shrink-0">
                {a.enabled ? (
                  <button
                    onClick={() => disableAdvisor(a.id)}
                    className="px-2.5 py-1 rounded border border-solix-border text-slate-400 text-xs hover:text-white hover:bg-solix-border/30"
                  >
                    Disable
                  </button>
                ) : (
                  <button
                    onClick={() => enableAdvisor(a.id)}
                    className="px-2.5 py-1 rounded bg-cyan-500/20 border border-cyan-400/60 text-cyan-100 text-xs hover:bg-cyan-500/30"
                  >
                    ＋ Add
                  </button>
                )}
                {a.enabled &&
                  (a.pinned ? (
                    <button
                      onClick={() => unpinAdvisor(a.id)}
                      className="px-2.5 py-1 rounded bg-amber-500/15 border border-amber-400/50 text-amber-200 text-xs hover:bg-amber-500/25"
                    >
                      Unpin
                    </button>
                  ) : (
                    <button
                      onClick={() => pinAdvisor(a.id)}
                      className="px-2.5 py-1 rounded bg-amber-500/10 border border-amber-400/30 text-amber-200/80 text-xs hover:bg-amber-500/20"
                      title="Spawn an always-on session"
                    >
                      Pin
                    </button>
                  ))}
                <button
                  onClick={() => {
                    selectAdvisor(a.id);
                    onClose();
                  }}
                  className="px-2.5 py-1 rounded border border-solix-border text-slate-300 text-xs hover:text-white hover:bg-solix-border/30"
                >
                  Details
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
