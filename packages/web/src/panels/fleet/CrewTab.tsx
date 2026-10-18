import { useEffect } from 'react';
import type { Advisor, Session } from '@solix/shared';
import { selectAllAdvisors, useSolixStore } from '../../store/index.js';
import { Button } from '../../ui/Button.js';

/**
 * Crew — the advisor roster.
 *
 * This was a 620px centred modal. At the dock's 480px the card's
 * side-by-side [description | vertical button stack] no longer fits, so the
 * cards are restructured rather than moved: identity row, description, then a
 * wrapping action row underneath.
 *
 * Two things here are load-bearing and were kept deliberately:
 *   - The open-time /api/advisors fetch. If the websocket snapshot arrived
 *     empty, the store stays empty until something *changes* an advisor, which
 *     the user cannot trigger because they see nothing to click.
 *   - Pin is a work-starting control: it spawns an always-on session that
 *     spends money for as long as it lives. It carries the caution colour and
 *     says so, and the per-advisor live spend stays on the card.
 */
export function CrewTab({ open }: { open: boolean }): JSX.Element {
  const advisors = useSolixStore(selectAllAdvisors);
  const sessions = useSolixStore((s) => s.sessions);

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

  const active = advisors.filter((a) => a.enabled);
  const optIn = advisors.filter((a) => !a.enabled);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
      <div className="text-xs text-slate-500">
        {active.length} active · {optIn.length} available. Enable one to add it
        to the inner ring and the + Task picker.
      </div>

      <CrewSection
        title={`Active crew · ${active.length}`}
        advisors={active}
        sessions={sessions}
      />
      {optIn.length > 0 && (
        <CrewSection
          title={`Available (opt-in) · ${optIn.length}`}
          advisors={optIn}
          sessions={sessions}
        />
      )}
      {advisors.length === 0 && (
        <div className="text-xs text-slate-500">
          No advisors found. The server may still be starting up.
        </div>
      )}
    </div>
  );
}

function CrewSection({
  title,
  advisors,
  sessions,
}: {
  title: string;
  advisors: Advisor[];
  sessions: Record<string, Session>;
}): JSX.Element {
  const enableAdvisor = useSolixStore((s) => s.enableAdvisor);
  const disableAdvisor = useSolixStore((s) => s.disableAdvisor);
  const pinAdvisor = useSolixStore((s) => s.pinAdvisor);
  const unpinAdvisor = useSolixStore((s) => s.unpinAdvisor);
  const selectAdvisor = useSolixStore((s) => s.selectAdvisor);

  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
        {title}
      </div>
      {/* Was one card per row at any width. Each card is self-contained,
          so a grid is strictly better use of a full-width surface. */}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {advisors.map((a) => {
          const pinnedSession = a.pinnedSessionId
            ? sessions[a.pinnedSessionId]
            : undefined;
          return (
            <div
              key={a.id}
              className="rounded border border-solix-border bg-black/20 p-3"
            >
              {/* Identity row. At 480px the model name wraps under the codename
                  instead of sharing its line. */}
              <div className="flex items-center gap-2 flex-wrap">
                <span style={{ color: a.color }}>{a.glyph}</span>
                <span className="font-semibold text-slate-100">
                  {a.codename}
                </span>
                {a.pinned ? (
                  <span
                    className="text-[9px] uppercase tracking-wider text-solix-warn border border-solix-warn/40 rounded px-1 py-0.5"
                    title="Always-on session — this is where an advisor costs tokens."
                  >
                    pinned
                    {pinnedSession
                      ? ` · $${pinnedSession.costUsd.toFixed(2)}`
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
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mt-0.5">
                {a.name} · {String(a.defaultModel)}
              </div>
              <div className="mt-1 text-xs text-slate-400 leading-snug">
                {a.description}
              </div>

              <div className="flex flex-wrap gap-1.5 mt-2">
                {a.enabled ? (
                  <Button variant="ghost" size="sm" onClick={() => disableAdvisor(a.id)}>
                    Disable
                  </Button>
                ) : (
                  <Button
                    variant="ok"
                    size="sm"
                    onClick={() => enableAdvisor(a.id)}
                    title="Free — adds it to the ring and the task picker, makes no API calls"
                  >
                    Add to crew
                  </Button>
                )}
                {a.enabled &&
                  (a.pinned ? (
                    <Button
                      variant="warn"
                      size="sm"
                      onClick={() => unpinAdvisor(a.id)}
                      title="Ends the always-on session and stops its spend"
                    >
                      Unpin
                    </Button>
                  ) : (
                    <Button
                      variant="warn"
                      size="sm"
                      onClick={() => pinAdvisor(a.id)}
                      title="Spawns an always-on session — it costs money for as long as it runs"
                    >
                      Pin · costs money
                    </Button>
                  ))}
                {/* No onClose here, deliberately. In the old modal this was
                    `selectAdvisor(id); onClose();`. Now that Crew is a dock tab,
                    closing would shut the advisor panel selectAdvisor just
                    opened. */}
                <Button variant="ghost" size="sm" onClick={() => selectAdvisor(a.id)}>
                  Details
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
