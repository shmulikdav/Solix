import { useSolixStore, selectPlanets } from '../store/index.js';
import { ConnectionDot } from './ConnectionDot.js';

interface TopBarProps {
  onOpenShare?: () => void;
  onNewTask?: () => void;
  onOpenTimeline?: () => void;
  onOpenHelp?: () => void;
  onOpenPlan?: () => void;
  onOpenFleet?: () => void;
  onOpenWorkspace?: () => void;
}

export function TopBar({
  onOpenShare,
  onNewTask,
  onOpenTimeline,
  onOpenHelp,
  onOpenPlan,
  onOpenFleet,
  onOpenWorkspace,
}: TopBarProps = {}): JSX.Element {
  const planets = useSolixStore(selectPlanets);
  const viewMode = useSolixStore((s) => s.viewMode);
  const playbackActive = useSolixStore((s) => s.playback.active);
  const exitPlayback = useSolixStore((s) => s.exitPlayback);
  const orgs = useSolixStore((s) => s.orgs);
  const currentOrgId = useSolixStore((s) => s.currentOrgId);

  const activeOrg = orgs.find((o) => o.id === currentOrgId);

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
    <div
      data-topbar=""
      className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-4 z-40"
    >
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
        <ConnectionDot />
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

      {/* flex-wrap + justify-end: this group grows every time a surface is
          added, and without wrapping the overflow silently pushes the
          right-most control (the help button) off the viewport edge. */}
      {/* The actions cluster. This is the group that grows every time a
          surface is added, so the browser smoke asserts it stays one row. */}
      <div
        data-topbar-actions=""
        className="pointer-events-auto flex flex-wrap items-center justify-end gap-2 sm:gap-3 text-xs max-w-full"
      >
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
            className="px-2 py-1 rounded bg-solix-accent/15 border border-solix-accent/40 text-solix-accent hover:bg-solix-accent/25"
            title="Launch a new Claude Code task (L)"
          >
            + Task
          </button>
        )}
        {onOpenWorkspace && (
          <button
            onClick={onOpenWorkspace}
            className="px-2 py-1 rounded bg-slate-500/15 border border-slate-400/40 text-slate-200 hover:bg-slate-500/25"
            title="Mission Control: whole-workspace overview (W) — also opens by clicking the sun"
          >
            ☀ Mission Control
          </button>
        )}
        {onOpenPlan && (
          <button
            onClick={onOpenPlan}
            className="px-2 py-1 rounded bg-slate-500/15 border border-slate-400/40 text-slate-200 hover:bg-slate-500/25"
            title="Maestro: describe a goal, get a plan you approve (P)"
          >
            ✷ Maestro
          </button>
        )}
        {onOpenFleet && (
          <button
            onClick={onOpenFleet}
            className="px-2 py-1 rounded bg-slate-500/15 border border-slate-400/40 text-slate-200 hover:bg-slate-500/25"
            title="Fleet: crew, skills, teams, routines, connections and orgs"
          >
            ⚙ Fleet
          </button>
        )}
        {onOpenShare && (
          <button
            onClick={onOpenShare}
            className="px-2 py-1 rounded bg-slate-500/15 border border-slate-400/40 text-slate-200 hover:bg-slate-500/25"
            title="Share: export, import, versions and audit (G)"
          >
            ⌬ Share
          </button>
        )}
        {/* Not a control. Switching, creating and deleting orgs live in
            Fleet > Orgs, but the active org changes which plans Maestro shows,
            so hiding it entirely would cost more than the button saves. */}
        {activeOrg && orgs.length > 1 && (
          <span
            title="Active org — scopes which plans you see. Change it in Fleet › Orgs."
            className="px-2 py-1 rounded bg-slate-500/10 border border-slate-400/20 text-slate-400 select-none"
          >
            ◭ {activeOrg.name}
          </span>
        )}
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
