import { useEffect, useState } from 'react';
import { useSolixStore } from '../store/index.js';

const STORAGE_KEY = 'solix.welcome.dismissed.v1';

interface WelcomeProps {
  onOpenGalaxy: () => void;
  /** When true, render the modal even if previously dismissed or sessions exist. */
  forceOpen?: boolean;
  /** Called when the user closes the modal (forceOpen path); the persistent
   * "dismissed" flag is also written so the auto-show no longer fires. */
  onClose?: () => void;
}

export function Welcome({
  onOpenGalaxy,
  forceOpen = false,
  onClose,
}: WelcomeProps): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);
  const advisorsMap = useSolixStore((s) => s.advisors);
  const skillCount = useSolixStore((s) => Object.keys(s.skills).length);
  const sessionCount = useSolixStore(
    (s) => Object.keys(s.sessions).length,
  );

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);

  // Auto-hide once the user has any session (real or demo) — they've moved past
  // the "empty galaxy" moment. forceOpen overrides both gates so the (?) help
  // button can always re-open it.
  if (!forceOpen) {
    if (dismissed) return null;
    if (sessionCount > 0) return null;
  }

  const close = (): void => {
    try {
      localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
    onClose?.();
  };

  const enabledAdvisors = Object.values(advisorsMap)
    .filter((a) => a.enabled)
    .sort((a, b) => a.codename.localeCompare(b.codename));

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto max-w-xl w-full mx-4 rounded-xl border border-solix-accent/40 bg-solix-panel/95 backdrop-blur-md shadow-2xl">
        <div className="px-6 pt-5 pb-3 border-b border-solix-border">
          <div className="text-xs uppercase tracking-widest text-solix-accent">
            welcome
          </div>
          <div className="text-2xl font-bold mt-1">
            Solix — your agent solar system
          </div>
          <div className="text-sm text-slate-400 mt-1">
            Mission control for Claude Code. Each agent orbits the sun;
            each click is a conversation with one of your planets.
          </div>
        </div>

        <div className="px-6 py-4 space-y-3 text-sm text-slate-300">
          <Step
            n={1}
            title="Run a Claude Code session"
            body={
              <>
                Open a terminal anywhere and run{' '}
                <code className="bg-black/40 px-1 rounded">claude</code>. A
                planet will appear here within a second.
              </>
            }
          />
          <Step
            n={2}
            title="Or seed the demo state"
            body={
              <>
                In another terminal:{' '}
                <code className="bg-black/40 px-1 rounded">solix demo</code>
                . You'll get a fully populated galaxy — ~30 sessions across 8
                projects, all 14 advisors, moons, and live permission flares —
                without running Claude Code.
              </>
            }
          />
          <Step
            n={3}
            title="Meet the advisor crew"
            body={
              <>
                {enabledAdvisors.length > 0
                  ? `${enabledAdvisors.length} crew members loaded. Click any in the inner ring to read their role and invoke them on the focused planet.`
                  : 'Crew loading…'}
                {enabledAdvisors.length > 0 && (
                  <ul className="mt-2 space-y-1">
                    {enabledAdvisors.map((a) => (
                      <li key={a.id} className="flex items-baseline gap-2">
                        <span
                          className="font-mono text-xs"
                          style={{ color: a.color }}
                        >
                          {a.glyph} {a.codename}
                        </span>
                        <span className="text-slate-500 text-xs">—</span>
                        <span className="text-slate-300 text-xs">
                          {a.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            }
          />
          <Step
            n={4}
            title="Browse the asteroid belt"
            body={
              <>
                Each asteroid is a Skill ({skillCount} discovered). Click
                one to read its SKILL.md and see which advisors require it.
              </>
            }
          />
          <Step
            n={5}
            title="Share your galaxy"
            body={
              <>
                Press{' '}
                <kbd className="px-1.5 py-0.5 rounded bg-black/50 border border-solix-border text-[10px]">
                  G
                </kbd>{' '}
                or click <span className="text-solix-accent">⌬ Galaxy</span>{' '}
                in the top bar to export, import, publish, or install a
                galaxy from a registry.
              </>
            }
          />
          <Step
            n={6}
            title="Orchestrate a build with Maestro (preview)"
            body={
              <>
                Press{' '}
                <kbd className="px-1.5 py-0.5 rounded bg-black/50 border border-solix-border text-[10px]">
                  P
                </kbd>{' '}
                or click <span className="text-amber-300">✷ Maestro</span> in
                the top bar to describe a goal — Maestro plans it into tasks you
                approve, then dispatches a fleet to build it, verifies each step,
                and shows you the diff. Budget-capped and governed.
              </>
            }
          />
        </div>

        <div className="px-6 pb-3 pt-1">
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
            Keyboard shortcuts
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-400">
            <Kbd k="V">cycle Galaxy → List → Missions</Kbd>
            <Kbd k="G">toggle Galaxy panel</Kbd>
            <Kbd k="P">Maestro — plan a build</Kbd>
            <Kbd k="L">new task</Kbd>
            <Kbd k="T">timeline</Kbd>
            <Kbd k="M">jump to Missions</Kbd>
            <Kbd k="Y">approve top decision</Kbd>
            <Kbd k="N">deny top decision</Kbd>
            <Kbd k="Space">play / pause orbits</Kbd>
            <Kbd k="?">re-open this help</Kbd>
            <Kbd k="Esc">close panels / exit playback</Kbd>
          </div>
          <div className="text-[10px] text-slate-500 italic mt-2">
            If clicks feel stuck, a third-party screen overlay (note-taker,
            recorder) may be intercepting. Quit it temporarily, or use the
            shortcuts above.
          </div>
        </div>

        <div className="px-6 py-3 border-t border-solix-border flex items-center gap-2">
          <button
            onClick={() => {
              onOpenGalaxy();
              close();
            }}
            className="px-3 py-1.5 rounded bg-solix-accent/15 border border-solix-accent/40 text-solix-accent text-xs hover:bg-solix-accent/25"
          >
            Open Galaxy panel
          </button>
          <div className="flex-1" />
          <span className="text-[10px] font-mono text-slate-500 mr-2">
            Solix v{__SOLIX_VERSION__}
          </span>
          <button
            onClick={close}
            className="px-3 py-1.5 rounded border border-solix-border text-xs text-slate-300 hover:text-white"
          >
            Got it
          </button>
        </div>
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

function Step({
  n,
  title,
  body,
}: {
  n: number;
  title: string;
  body: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 w-6 h-6 rounded-full bg-solix-accent/20 border border-solix-accent/40 text-solix-accent text-xs flex items-center justify-center">
        {n}
      </div>
      <div>
        <div className="text-slate-100 font-medium text-sm">{title}</div>
        <div className="text-slate-400 text-xs mt-0.5 leading-relaxed">
          {body}
        </div>
      </div>
    </div>
  );
}
