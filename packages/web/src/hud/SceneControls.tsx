import { useEffect, useState } from 'react';
import { selectDockOffsetPx, useSolixStore } from '../store/index.js';

const HINT_KEY = 'solix.scenehint.dismissed.v1';

export function SceneControls(): JSX.Element {
  const motionEnabled = useSolixStore((s) => s.motionEnabled);
  const viewMode = useSolixStore((s) => s.viewMode);
  const dockOffsetPx = useSolixStore(selectDockOffsetPx);
  const toggleMotion = useSolixStore((s) => s.toggleMotion);
  const [hintDismissed, setHintDismissed] = useState(true);

  useEffect(() => {
    try {
      setHintDismissed(localStorage.getItem(HINT_KEY) === '1');
    } catch {
      /* ignore */
    }
  }, []);

  const dismissHint = (): void => {
    try {
      localStorage.setItem(HINT_KEY, '1');
    } catch {
      /* ignore */
    }
    setHintDismissed(true);
  };

  return (
    <>
      {viewMode === 'galaxy' && !hintDismissed && (
        <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 z-20">
          <div className="pointer-events-auto rounded-full border border-solix-border bg-solix-panel/85 backdrop-blur px-3 py-1.5 text-[11px] text-slate-300 flex items-center gap-3">
            <span>
              <kbd className="px-1 py-0.5 rounded bg-black/40 border border-solix-border text-[10px] mr-1">
                drag
              </kbd>
              pan
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-black/40 border border-solix-border text-[10px] mr-1">
                scroll
              </kbd>
              zoom
            </span>
            <span>
              <kbd className="px-1 py-0.5 rounded bg-black/40 border border-solix-border text-[10px] mr-1">
                space
              </kbd>
              pause
            </span>
            <button
              onClick={dismissHint}
              className="ml-1 text-slate-500 hover:text-slate-100"
              aria-label="Dismiss hint"
            >
              ✕
            </button>
          </div>
        </div>
      )}
      {/* Orbital motion only exists in the galaxy view — the button rendered in
          List and Missions too, where nothing orbits and pressing it did
          nothing visible. */}
      {viewMode === 'galaxy' && (
      <div
        className="pointer-events-none absolute bottom-4 z-20"
        // Consume the same dock offset the Decision Queue uses — this control
        // previously sat behind every open panel.
        style={{ right: dockOffsetPx + 16 }}
      >
        <button
          onClick={toggleMotion}
          title={`${motionEnabled ? 'Pause' : 'Play'} orbital motion (Space)`}
          className={`pointer-events-auto w-10 h-10 rounded-full text-base flex items-center justify-center border backdrop-blur transition-colors ${
            motionEnabled
              ? 'bg-solix-accent/20 border-solix-accent text-solix-accent'
              : 'bg-solix-panel/80 border-solix-border text-slate-300 hover:bg-solix-border/40 hover:text-white'
          }`}
        >
          {motionEnabled ? '⏸' : '▶'}
        </button>
      </div>
      )}
    </>
  );
}
