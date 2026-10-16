import { useSolixStore, selectPlanets } from '../store/index.js';
import { NEW_SKILL_ID } from '../panels/SkillPanel.js';

interface TopBarProps {
  onOpenGalaxy?: () => void;
  onNewTask?: () => void;
  onOpenTimeline?: () => void;
  onOpenHelp?: () => void;
  onOpenCrew?: () => void;
  onOpenPlan?: () => void;
  onOpenConnections?: () => void;
}

export function TopBar({
  onOpenGalaxy,
  onNewTask,
  onOpenTimeline,
  onOpenHelp,
  onOpenCrew,
  onOpenPlan,
  onOpenConnections,
}: TopBarProps = {}): JSX.Element {
  const connected = useSolixStore((s) => s.connected);
  const planets = useSolixStore(selectPlanets);
  const viewMode = useSolixStore((s) => s.viewMode);
  const playbackActive = useSolixStore((s) => s.playback.active);
  const exitPlayback = useSolixStore((s) => s.exitPlayback);
  const selectSkill = useSolixStore((s) => s.selectSkill);

  const counts = planets.reduce(
    (acc, s) => {
      if (s.status === 'active') acc.active += 1;
      else if (
        s.status === 'awaiting_permission' ||
        s.status === 'awaiting_input' ||
        s.status === 'plan_review'
      )
        acc.attention += 1;
      else if (s.status === 'idle') acc.idle += 1;
      return acc;
    },
    { active: 0, idle: 0, attention: 0 },
  );

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-4 z-40">
      <div className="pointer-events-auto flex items-center gap-2 sm:gap-3">
        <div className="flex items-baseline gap-1.5">
          <div className="text-xl font-bold tracking-widest text-solix-accent">
            SOLIX
          </div>
          <span
            className="text-[10px] font-mono text-slate-500"
            title={`Solix v${__SOLIX_VERSION__} — built into this UI bundle`}
          >
            v{__SOLIX_VERSION__}
          </span>
        </div>
        <div className="hidden md:block text-xs text-slate-400">
          a solar-system command center
        </div>
        <div
          className={`ml-1 sm:ml-3 px-2 py-1 rounded text-[10px] border ${
            connected
              ? 'border-solix-ok text-solix-ok'
              : 'border-solix-danger text-solix-danger solix-pulse'
          }`}
        >
          {connected ? 'CONNECTED' : 'OFFLINE'}
        </div>
        {playbackActive && (
          <button
            onClick={exitPlayback}
            className="ml-2 px-2 py-1 rounded text-[10px] border border-solix-accent text-solix-accent solix-pulse hover:bg-solix-accent/15 cursor-pointer flex items-center gap-1.5"
            title="Exit Timeline Playback (Esc)"
            aria-label="Exit playback"
          >
            <span>▸ PLAYBACK</span>
            <span className="opacity-70">· exit ✕</span>
          </button>
        )}
      </div>

      <div className="pointer-events-auto flex items-center gap-2 sm:gap-3 text-xs">
        {/* Counters and timeline are useful but not critical on mobile;
            hide them at <sm to keep the topbar single-row. */}
        <div className="hidden sm:flex items-center gap-2">
          <Stat label="active" value={counts.active} color="text-solix-ok" />
          <Stat label="attention" value={counts.attention} color="text-solix-warn" />
          <Stat label="idle" value={counts.idle} color="text-slate-400" />
        </div>
        <ViewToggle viewMode={viewMode} />
        {onOpenTimeline && (
          <button
            onClick={onOpenTimeline}
            className="hidden sm:inline-block px-2 py-1 rounded bg-solix-panel border border-solix-border text-slate-300 hover:text-white hover:bg-solix-border/30"
            title="Timeline playback (T)"
          >
            ⏱ Timeline
          </button>
        )}
        {onNewTask && (
          <button
            onClick={onNewTask}
            className="px-2 py-1 rounded bg-solix-ok/15 border border-solix-ok/40 text-solix-ok hover:bg-solix-ok/25"
            title="Launch a new Claude Code task (L)"
          >
            + Task
          </button>
        )}
        {onOpenCrew && (
          <button
            onClick={onOpenCrew}
            className="px-2 py-1 rounded bg-amber-500/15 border border-amber-400/40 text-amber-200 hover:bg-amber-500/25"
            title="Crew: view and enable advisors (C)"
          >
            ✦ Crew
          </button>
        )}
        {onOpenPlan && (
          <button
            onClick={onOpenPlan}
            className="px-2 py-1 rounded bg-amber-400/15 border border-amber-300/50 text-amber-100 hover:bg-amber-400/25"
            title="Maestro: describe a goal, get a plan you approve (P)"
          >
            ✷ Maestro
          </button>
        )}
        {onOpenConnections && (
          <button
            onClick={onOpenConnections}
            className="px-2 py-1 rounded bg-slate-500/15 border border-slate-400/40 text-slate-200 hover:bg-slate-500/25"
            title="Connections: API keys & secrets granted to agents"
          >
            ⚷ Connections
          </button>
        )}
        {onOpenGalaxy && (
          <button
            onClick={onOpenGalaxy}
            className="px-2 py-1 rounded bg-solix-accent/15 border border-solix-accent/40 text-solix-accent hover:bg-solix-accent/25"
            title="Galaxy: export and import (G)"
          >
            ⌬ Galaxy
          </button>
        )}
        <button
          onClick={() => selectSkill(NEW_SKILL_ID)}
          className="px-2 py-1 rounded bg-cyan-500/15 border border-cyan-400/40 text-cyan-200 hover:bg-cyan-500/25"
          title="Author a new skill"
        >
          ✎ Skill
        </button>
        {onOpenHelp && (
          <button
            onClick={onOpenHelp}
            className="w-7 h-7 rounded-full bg-solix-panel border border-solix-border text-slate-300 hover:text-white hover:bg-solix-border/30 text-sm"
            title="Help (?)"
            aria-label="Help"
          >
            ?
          </button>
        )}
      </div>
    </div>
  );
}

function ViewToggle({
  viewMode,
}: {
  viewMode: 'galaxy' | 'list' | 'missions';
}): JSX.Element {
  const setViewMode = useSolixStore((s) => s.setViewMode);
  const opts: { mode: 'galaxy' | 'list' | 'missions'; label: string }[] = [
    { mode: 'galaxy', label: '🪐' },
    { mode: 'list', label: '☰' },
    { mode: 'missions', label: '◎' },
  ];
  return (
    <div className="inline-flex rounded border border-solix-border bg-solix-panel overflow-hidden">
      {opts.map((o) => (
        <button
          key={o.mode}
          onClick={() => setViewMode(o.mode)}
          className={`px-2 py-1 text-xs ${
            viewMode === o.mode
              ? 'bg-solix-border/50 text-white'
              : 'text-slate-400 hover:text-slate-100'
          }`}
          title={`${o.mode} view (V)`}
        >
          {o.label}{' '}
          <span className="hidden sm:inline capitalize">{o.mode}</span>
        </button>
      ))}
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}): JSX.Element {
  return (
    <div className="px-2 py-1 rounded bg-solix-panel border border-solix-border">
      <span className={`font-bold ${color}`}>{value}</span>
      <span className="ml-1 opacity-60 uppercase tracking-wide">{label}</span>
    </div>
  );
}
