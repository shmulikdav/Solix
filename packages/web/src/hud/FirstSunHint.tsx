import { useEffect, useRef, useState } from 'react';
import {
  selectDockOffsetPx,
  selectPendingPermissionsOrdered,
  useSolixStore,
} from '../store/index.js';
import { readSunHintSeen, writeSunHintSeen } from './onboarding.js';

/** How long the hint stays up before fading on its own. */
const HINT_MS = 8000;

/**
 * One-time hint that the sun is clickable.
 *
 * The audit asked for a pulse on the sun the first time a session appears.
 * That does not work here: `scene/Sun.tsx` already lerps the sun's light and
 * scale with the number of active sessions, and the prominences already flare
 * red on attention — so a pulse fired by the first session arriving would be
 * indistinguishable from the sun's ordinary reaction to that same session.
 * Brightness also does not say "click me"; it says "something is happening".
 *
 * The real gap is a moment, not an animation. `EmptyHint` tells you the sun is
 * mission control while the system is empty, and then disappears at exactly
 * the point where you first have something to click. This fills that gap once,
 * says what to do, and never comes back.
 */
export function FirstSunHint({
  suppressed,
}: {
  /** True while the welcome modal is up, so the two don't collide. */
  suppressed: boolean;
}): JSX.Element | null {
  const sessionCount = useSolixStore((s) => Object.keys(s.sessions).length);
  const viewMode = useSolixStore((s) => s.viewMode);
  const activePanel = useSolixStore((s) => s.activePanel);
  const dockOffsetPx = useSolixStore(selectDockOffsetPx);
  // A pending permission is both more urgent and more fragile than this hint:
  // it is the thing that unblocks a stuck agent, and the Decision Queue sits
  // in the middle of the view. Rather than fight it for space — which is how
  // a permission prompt ends up covered — the hint waits.
  const pendingCount = useSolixStore(
    (s) => selectPendingPermissionsOrdered(s).length,
  );

  const [visible, setVisible] = useState(false);
  const settled = useRef(readSunHintSeen());

  useEffect(() => {
    if (settled.current || suppressed || pendingCount > 0) return;
    if (sessionCount === 0 || viewMode !== 'galaxy') return;
    settled.current = true;
    writeSunHintSeen();
    setVisible(true);
    const t = setTimeout(() => setVisible(false), HINT_MS);
    return () => clearTimeout(t);
  }, [sessionCount, viewMode, suppressed, pendingCount]);

  // Opening Mission Control is the hint being acted on; it has done its job.
  useEffect(() => {
    if (activePanel === 'workspace') setVisible(false);
  }, [activePanel]);

  if (!visible) return null;

  return (
    // Bottom of the galaxy area, not the middle: the centre belongs to the sun
    // this is pointing at and to the Decision Queue. Respects the dock offset
    // for the same reason the queue does.
    <div
      className="pointer-events-none absolute bottom-20 left-0 flex justify-center z-10"
      style={{ right: dockOffsetPx }}
    >
      <div className="rounded-lg border border-solix-accent/40 bg-solix-panel/95 px-4 py-2.5 backdrop-blur text-center solix-fade-in">
        <div className="text-sm text-slate-100">
          ☀ That's the sun, up there — your whole workspace.
        </div>
        <div className="text-xs text-slate-400 mt-0.5">
          Click it for Mission Control: total spend, context pressure, every
          agent at once.
        </div>
      </div>
    </div>
  );
}
