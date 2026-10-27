import { useEffect, useState } from 'react';
import { clearDismissed } from './onboarding.js';
import { useSolixStore } from '../store/index.js';
import type { ChecklistItem } from './onboarding.js';

/**
 * Help — the reference, always reachable with `?`.
 *
 * Split out of Welcome, which it used to share a component with. That sharing
 * had a real cost: help's "Got it" button wrote the first-run dismissed flag,
 * so pressing ? once permanently consumed someone's onboarding.
 *
 * Closing this writes nothing.
 */
export function HelpPanel({
  open,
  onClose,
  onShowWelcome,
}: {
  open: boolean;
  onClose: () => void;
  /** Re-opens the welcome modal after clearing its dismissed flag. */
  onShowWelcome?: () => void;
}): JSX.Element | null {
  const sessionCount = useSolixStore((s) => Object.keys(s.sessions).length);
  const planCount = useSolixStore((s) => Object.keys(s.plans).length);
  const userSkillCount = useSolixStore(
    (s) => Object.values(s.skills).filter((k) => k.source === 'user').length,
  );
  const [approvedOne, setApprovedOne] = useState(false);

  // "Have you approved a decision yet" comes from the persisted audit log
  // rather than a localStorage flag, so it survives a cleared browser and is
  // true for the right reason.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/audit')
      .then((r) => (r.ok ? r.json() : []))
      .then((events: Array<{ kind?: string }>) => {
        if (cancelled || !Array.isArray(events)) return;
        setApprovedOne(events.some((e) => e.kind === 'permission_approved'));
      })
      .catch(() => {
        /* leave it unticked */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const checklist: ChecklistItem[] = [
    {
      id: 'session',
      label: 'An agent has run',
      hint: 'Run `claude` in a terminal, or `solix demo` for a populated galaxy.',
      done: sessionCount > 0,
    },
    {
      id: 'approved',
      label: 'You approved a decision',
      hint: 'When an agent wants to do something risky it asks here first. Y approves, N denies.',
      done: approvedOne,
    },
    {
      id: 'plan',
      label: 'You planned a build',
      hint: 'Press P, describe a goal, approve the plan Maestro writes.',
      done: planCount > 0,
    },
    {
      id: 'skill',
      label: 'You have a skill of your own',
      hint: 'Fleet › Skills to write one, or Fleet › Teams to install a bundle.',
      done: userSkillCount > 0,
    },
  ];

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Help"
    >
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-lg"
        onClick={onClose}
      />
      <div className="relative z-10 max-w-2xl w-full mx-4 max-h-[88vh] flex flex-col rounded-xl border border-solix-accent/40 bg-solix-panel shadow-2xl">
        <div className="px-6 pt-5 pb-3 border-b border-solix-border flex items-start justify-between">
          <div>
            <div className="text-xs uppercase tracking-widest text-solix-accent">
              help
            </div>
            <div className="text-xl font-bold mt-0.5">
              What you're looking at
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

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* The vocabulary everything else depends on. This was previously
              only in hover tooltips, which you cannot discover by reading. */}
          <section>
            <SectionTitle>The map</SectionTitle>
            <div className="space-y-1.5">
              <Term glyph="☀" name="Sun" color="#f59e0b">
                Your workspace. Click it for Mission Control — total spend,
                context pressure, everything at once.
              </Term>
              <Term glyph="●" name="Planet" color="#a855f7">
                One agent session. Click it to read its transcript, see its
                cost, and talk to it.
              </Term>
              <Term glyph="◦" name="Moon" color="#94a3b8">
                A subagent spawned by the planet it orbits.
              </Term>
              <Term glyph="✦" name="Inner ring" color="#22d3ee">
                Your advisor crew. Click one to read its role and invoke it on
                the focused planet.
              </Term>
              <Term glyph="◆" name="Asteroid belt" color="#64748b">
                Skills — reusable instructions agents can use. Click one to read
                it.
              </Term>
              <Term glyph="◉" name="Flare" color="#ef4444">
                An agent is blocked waiting for you to approve something.
              </Term>
            </div>
          </section>

          <section>
            <SectionTitle>Getting started</SectionTitle>
            <div className="space-y-1.5">
              {checklist.map((item) => (
                <div key={item.id} className="flex gap-2.5 items-start">
                  <span
                    className={`shrink-0 w-4 h-4 mt-0.5 rounded-sm border flex items-center justify-center text-[10px] ${
                      item.done
                        ? 'bg-solix-ok/20 border-solix-ok/50 text-solix-ok'
                        : 'border-solix-border text-transparent'
                    }`}
                    aria-hidden="true"
                  >
                    ✓
                  </span>
                  <div className="min-w-0">
                    <div
                      className={`text-xs ${item.done ? 'text-slate-500 line-through' : 'text-slate-200'}`}
                    >
                      {item.label}
                    </div>
                    {!item.done && (
                      <div className="text-[11px] text-slate-500 leading-snug">
                        {item.hint}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section>
            <SectionTitle>Shortcuts</SectionTitle>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-400">
              <Kbd k="P">Maestro — plan a build</Kbd>
              <Kbd k="L">new task</Kbd>
              <Kbd k="W">Mission Control</Kbd>
              <Kbd k="C">Fleet — crew</Kbd>
              <Kbd k="G">Share — export / import</Kbd>
              <Kbd k="T">timeline</Kbd>
              <Kbd k="V">cycle Galaxy → List → Missions</Kbd>
              <Kbd k="M">jump to Missions</Kbd>
              <Kbd k="Y">approve the top decision</Kbd>
              <Kbd k="N">deny the top decision</Kbd>
              <Kbd k="?">this help</Kbd>
              <Kbd k="Esc">close a panel / exit playback</Kbd>
            </div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 mt-3 mb-1.5">
              In galaxy view only
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-400">
              <Kbd k="+">zoom in</Kbd>
              <Kbd k="−">zoom out</Kbd>
              <Kbd k="0">reset the camera</Kbd>
              <Kbd k="↑ ↓ ← →">orbit the camera</Kbd>
              <Kbd k="Space">play / pause orbits</Kbd>
            </div>
          </section>

          <section>
            <SectionTitle>When something costs money</SectionTitle>
            <div className="text-xs text-slate-400 leading-snug space-y-1.5">
              <p>
                Anything that starts an agent spends tokens. Those controls are
                coloured{' '}
                <span className="text-solix-warn">amber</span> and say so.
              </p>
              <p>
                Two are easy to miss. <strong>Pinning</strong> an advisor runs an
                always-on session that spends until you unpin it. A{' '}
                <strong>routine</strong> starts an agent on a cadence, forever —
                Fleet › Routines lists every one and can turn it off.
              </p>
            </div>
          </section>

          <div className="text-[10px] text-slate-500 italic">
            If clicks feel stuck, a third-party screen overlay (note-taker,
            recorder) may be intercepting them. Quit it, or use the shortcuts
            above.
          </div>
        </div>

        <div className="px-6 py-3 border-t border-solix-border flex items-center">
          {/* Until this existed, dismissing the welcome modal — including by
              one Escape that also closed this panel — ended onboarding
              permanently, with DevTools as the only way back. */}
          <button
            onClick={() => {
              clearDismissed();
              onClose();
              onShowWelcome?.();
            }}
            className="px-3 py-1.5 rounded border border-solix-border text-xs text-slate-400 hover:text-white"
          >
            Show the welcome again
          </button>
          <div className="flex-1" />
          <span className="text-[10px] font-mono text-slate-500 mr-3">
            Solix v{__SOLIX_VERSION__}
          </span>
          {/* Closing help writes nothing. It used to persist the first-run
              dismissed flag. */}
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded border border-solix-border text-xs text-slate-300 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
      {children}
    </div>
  );
}

function Term({
  glyph,
  name,
  color,
  children,
}: {
  glyph: string;
  name: string;
  color: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex gap-2.5 items-baseline">
      <span className="shrink-0 w-4 text-center font-mono" style={{ color }}>
        {glyph}
      </span>
      <div className="min-w-0 text-xs">
        <span className="text-slate-100 font-medium">{name}</span>
        <span className="text-slate-400"> — {children}</span>
      </div>
    </div>
  );
}

function Kbd({
  k,
  children,
}: {
  k: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <kbd className="shrink-0 px-1.5 py-0.5 rounded bg-black/50 border border-solix-border text-[10px] font-mono text-slate-300">
        {k}
      </kbd>
      <span className="truncate">{children}</span>
    </div>
  );
}
