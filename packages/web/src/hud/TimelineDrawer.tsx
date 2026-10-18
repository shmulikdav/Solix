import { useEffect, useRef, useState } from 'react';
import type { TimelineEvent } from '@solix/shared';
import { selectDockOffsetPx, useSolixStore } from '../store/index.js';
import { RAIL_WIDTH_PX } from '../shell/surfaces.js';

interface TimelineRange {
  earliest: number;
  latest: number;
  events: TimelineEvent[];
}

interface TimelineDrawerProps {
  open: boolean;
  onClose: () => void;
}

const SPEEDS = [1, 4, 16, 64];

/**
 * Bottom drawer for time-scrubbing the scene.
 *
 * Pulls the last 30 minutes of events from /api/timeline (synthesized
 * from missions + tool_calls + sessions). The store derives "scene at
 * time T" from those events client-side, so dragging the slider is
 * instantaneous — no per-scrub server round-trip.
 *
 * Play / Pause advances currentMs by `speed` × elapsed real time per
 * frame. Hitting the latest end pauses automatically.
 */
export function TimelineDrawer({
  open,
  onClose,
}: TimelineDrawerProps): JSX.Element | null {
  const playback = useSolixStore((s) => s.playback);
  const dockOffsetPx = useSolixStore(selectDockOffsetPx);
  const enterPlayback = useSolixStore((s) => s.enterPlayback);
  const exitPlayback = useSolixStore((s) => s.exitPlayback);
  const setPlaybackTime = useSolixStore((s) => s.setPlaybackTime);
  const setPlaybackSpeed = useSolixStore((s) => s.setPlaybackSpeed);
  const setPlaybackPlaying = useSolixStore((s) => s.setPlaybackPlaying);
  const setPlaybackLoading = useSolixStore((s) => s.setPlaybackLoading);

  const [rangeMinutes, setRangeMinutes] = useState(30);

  // Auto-fetch the timeline when the drawer first opens.
  useEffect(() => {
    if (!open) return;
    if (playback.active && playback.events.length > 0) return;
    setPlaybackLoading(true);
    const sinceMs = Date.now() - rangeMinutes * 60 * 1000;
    fetch(`/api/timeline?sinceMs=${sinceMs}&untilMs=${Date.now()}`)
      .then((r) => r.json())
      .then((tr: TimelineRange) => {
        if (tr.events.length === 0) {
          setPlaybackLoading(false);
          enterPlayback([], Date.now() - 60_000, Date.now());
          return;
        }
        enterPlayback(tr.events, tr.earliest, tr.latest);
      })
      .catch((err) => {
        console.warn('[timeline] fetch failed', err);
        setPlaybackLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rangeMinutes]);

  // Animate currentMs forward when playing.
  const lastTickRef = useRef<number>(0);
  useEffect(() => {
    if (!playback.active || !playback.playing) return;
    let raf = 0;
    const tick = (t: number): void => {
      const dt = lastTickRef.current ? t - lastTickRef.current : 16;
      lastTickRef.current = t;
      const next = playback.currentMs + dt * playback.speed;
      if (next >= playback.latestMs) {
        setPlaybackTime(playback.latestMs);
        setPlaybackPlaying(false);
      } else {
        setPlaybackTime(next);
        raf = requestAnimationFrame(tick);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      lastTickRef.current = 0;
    };
  }, [playback.active, playback.playing, playback.speed, playback.latestMs]);

  if (!open) return null;

  const onCloseHandler = (): void => {
    exitPlayback();
    onClose();
  };

  const span = Math.max(1, playback.latestMs - playback.earliestMs);
  const progressPct = playback.active
    ? ((playback.currentMs - playback.earliestMs) / span) * 100
    : 0;

  const eventsBefore = playback.events.filter(
    (e) => e.ts <= playback.currentMs,
  );

  // Stop at the dock's edge instead of running under it. The drawer and the
  // dock panels are both z-30 and the drawer renders later, so on a tie it
  // won — covering the bottom of whatever panel was open, which for the plan
  // panel is its Approve and Abort buttons.

  return (
    <div
      className="absolute bottom-0 z-30 bg-solix-panel/95 backdrop-blur border-t border-solix-border"
      style={{ left: RAIL_WIDTH_PX, right: dockOffsetPx }}
    >
      <div className="px-4 py-3 max-w-6xl mx-auto">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <span className="text-xs uppercase tracking-widest text-solix-accent">
              ▸ Playback
            </span>
            <span className="text-[10px] text-slate-400">
              {playback.events.length} events · last {rangeMinutes} min
            </span>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={rangeMinutes}
              onChange={(e) => setRangeMinutes(parseInt(e.target.value, 10))}
              className="text-[10px] bg-black/40 border border-solix-border rounded px-1.5 py-0.5 text-slate-300"
            >
              <option value={5}>5 min</option>
              <option value={15}>15 min</option>
              <option value={30}>30 min</option>
              <option value={60}>1 hour</option>
              <option value={180}>3 hours</option>
            </select>
            <button
              onClick={onCloseHandler}
              className="text-slate-400 hover:text-slate-100 text-xs"
            >
              ✕ Live
            </button>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setPlaybackPlaying(!playback.playing)}
            disabled={!playback.active || playback.events.length === 0}
            className="w-8 h-8 rounded-full bg-solix-accent/20 border border-solix-accent text-solix-accent text-sm hover:bg-solix-accent/30 disabled:opacity-40 flex items-center justify-center"
          >
            {playback.playing ? '⏸' : '▶'}
          </button>

          <div className="flex-1 relative">
            <input
              type="range"
              min={playback.earliestMs}
              max={playback.latestMs}
              value={playback.currentMs}
              onChange={(e) =>
                setPlaybackTime(parseInt(e.target.value, 10))
              }
              className="w-full"
              disabled={!playback.active}
            />
            <div
              className="absolute -top-1.5 h-0.5 bg-solix-accent/40 pointer-events-none"
              style={{ left: 0, width: `${progressPct}%` }}
            />
          </div>

          <div className="flex items-center gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                onClick={() => setPlaybackSpeed(s)}
                className={`text-[10px] px-1.5 py-0.5 rounded border ${
                  playback.speed === s
                    ? 'bg-solix-accent/20 border-solix-accent text-solix-accent'
                    : 'border-solix-border text-slate-400 hover:text-slate-200'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500 font-mono">
          <span>{formatTime(playback.earliestMs)}</span>
          <span className="text-solix-accent">
            {formatTime(playback.currentMs)} · {eventsBefore.length} events
          </span>
          <span>{formatTime(playback.latestMs)}</span>
        </div>

        {playback.loading && (
          <div className="text-center text-xs text-slate-500 italic mt-2">
            Loading timeline…
          </div>
        )}

        {!playback.loading && playback.events.length === 0 && playback.active && (
          <div className="text-center text-xs text-slate-500 italic mt-2">
            No events in this range. Try a longer window or run some
            agents first.
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(ms: number): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
