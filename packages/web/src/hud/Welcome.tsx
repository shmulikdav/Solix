import { useEffect, useState } from 'react';
import { readDismissed, writeDismissed } from './onboarding.js';

interface WelcomeProps {
  /** Opens Maestro, so step 2's first option can actually do the thing. */
  onPlanBuild: () => void;
  /** Opens Fleet on the Crew tab. */
  onOpenCrew: () => void;
  /** Fired when this closes, by any route. App needs to know because the
   *  first-run sun hint must not appear behind this modal, and reading the
   *  dismissed flag from App would go stale — closing this re-renders only
   *  this component. */
  onDismissed?: () => void;
}

/**
 * First run, and only first run.
 *
 * Three changes from what this was:
 *
 *   1. It no longer hides itself once sessions exist. That gate meant
 *      `solix demo` — the first command the README suggests — permanently
 *      destroyed onboarding, because it seeds about thirty sessions.
 *   2. It is no longer the same component as help. Opening help and clicking
 *      "Got it" used to write the first-run flag, silently consuming the
 *      onboarding of anyone who pressed ? before reading it.
 *   3. It is three steps with one action, not six cards of prose. The old one
 *      explained the whole product before letting you do anything, and ended
 *      on a feature marked "(preview)".
 *
 * The reference material it used to carry — the full shortcut legend, the
 * vocabulary, the checklist — lives in HelpPanel, which is always reachable.
 */
export function Welcome({
  onPlanBuild,
  onOpenCrew,
  onDismissed,
}: WelcomeProps): JSX.Element | null {
  // Read synchronously. Hydrating this in an effect showed returning users a
  // frame of the modal on every load.
  const [dismissed, setDismissed] = useState(readDismissed);
  const [copied, setCopied] = useState(false);

  // Escape, from here rather than App's keymap: App cannot see this local
  // flag, and its Escape branch only cleared `helpOpen`, which is already
  // false on a genuine first run — so Escape did nothing at all.
  useEffect(() => {
    if (dismissed) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      writeDismissed();
      setDismissed(true);
      onDismissed?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismissed, onDismissed]);

  if (dismissed) return null;

  const close = (): void => {
    writeDismissed();
    setDismissed(true);
    onDismissed?.();
  };

  const copyDemo = (): void => {
    void navigator.clipboard
      ?.writeText('solix demo')
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Solix"
    >
      {/* Clicking outside closes it. The old modal had no ✕, no backdrop
          handler, and its Escape path only cleared a flag that was already
          false on a genuine first run — so it could not be dismissed at all
          except by the one button at the bottom. */}
      <div
        className="absolute inset-0 bg-black/80 backdrop-blur-lg"
        onClick={close}
      />
      <div className="relative z-10 max-w-lg w-full mx-4 rounded-xl border border-solix-accent/40 bg-solix-panel shadow-2xl">
        <div className="px-6 pt-5 pb-4 border-b border-solix-border flex items-start justify-between gap-3">
          <div>
            <div className="text-xs uppercase tracking-widest text-solix-accent">
              welcome
            </div>
            <div className="text-2xl font-bold mt-1">Solix</div>
            <div className="text-sm text-slate-400 mt-1 leading-snug">
              A live map of your Claude Code agents. Everything orbiting the sun
              is an agent session — the sun is your workspace, and each planet is
              one agent you can open and talk to.
            </div>
          </div>
          <button
            onClick={close}
            className="text-slate-400 hover:text-slate-100 shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="px-6 py-4">
          <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-2">
            Pick one to start
          </div>
          <div className="space-y-2">
            <Choice
              title="Plan a build"
              body="Describe a goal. Maestro breaks it into tasks you approve, then runs an agent per task and shows you the diff."
              cost="costs money once you approve the plan"
              onClick={() => {
                close();
                onPlanBuild();
              }}
              primary
            />
            <Choice
              title="Look at the crew first"
              body="Fourteen advisors with different jobs. Enabling one is free — it only costs tokens when you pin or invoke it."
              cost="free"
              onClick={() => {
                close();
                onOpenCrew();
              }}
            />
            <Choice
              title="I'll run claude myself"
              body="Open a terminal anywhere and run claude. A planet appears here within a second."
              cost="free — this just closes"
              onClick={close}
            />
          </div>

          <div className="mt-4 pt-3 border-t border-solix-border text-xs text-slate-400 flex items-center gap-2 flex-wrap">
            <span>Want a populated galaxy to explore? Run</span>
            <code className="bg-black/40 px-1.5 py-0.5 rounded font-mono text-slate-200">
              solix demo
            </code>
            <button
              onClick={copyDemo}
              className="px-1.5 py-0.5 rounded border border-solix-border text-[10px] text-slate-400 hover:text-white"
            >
              {copied ? 'copied' : 'copy'}
            </button>
          </div>
        </div>

        <div className="px-6 py-3 border-t border-solix-border flex items-center gap-2">
          <span className="text-xs text-slate-500">
            Press{' '}
            <kbd className="px-1.5 py-0.5 rounded bg-black/50 border border-solix-border text-[10px] font-mono text-slate-300">
              ?
            </kbd>{' '}
            any time for the map legend and shortcuts.
          </span>
          <div className="flex-1" />
          <span className="text-[10px] font-mono text-slate-500">
            v{__SOLIX_VERSION__}
          </span>
        </div>
      </div>
    </div>
  );
}

function Choice({
  title,
  body,
  cost,
  onClick,
  primary = false,
}: {
  title: string;
  body: string;
  cost: string;
  onClick: () => void;
  primary?: boolean;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
        primary
          ? 'border-solix-accent/50 bg-solix-accent/10 hover:bg-solix-accent/20'
          : 'border-solix-border bg-black/20 hover:bg-solix-border/20'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`text-sm font-medium ${primary ? 'text-solix-accent' : 'text-slate-100'}`}
        >
          {title}
        </span>
        <span
          className={`text-[10px] shrink-0 ${
            cost === 'free' || cost.startsWith('free')
              ? 'text-solix-ok/80'
              : 'text-solix-warn/90'
          }`}
        >
          {cost}
        </span>
      </div>
      <div className="text-xs text-slate-400 mt-0.5 leading-snug">{body}</div>
    </button>
  );
}
