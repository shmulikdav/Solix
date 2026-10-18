import { selectPlanets, useSolixStore } from '../store/index.js';
import { RAIL_WIDTH_PX, TOP_BAR_HEIGHT_PX } from '../shell/surfaces.js';
import { ConnectionDot } from './ConnectionDot.js';

/**
 * The top strip, after the nav rail took the destinations.
 *
 * It used to carry four unrelated jobs — identity, status, the view switch and
 * seven destinations — in one row, and wrapped onto a second line as a result.
 * Identity moved to the rail header, destinations to the rail body. What is
 * left is the two things that answer "where am I and is anything wrong":
 * a breadcrumb and live status.
 */
export function TopBar(): JSX.Element {
  const viewMode = useSolixStore((s) => s.viewMode);
  const activePanel = useSolixStore((s) => s.activePanel);
  const activePanelTab = useSolixStore((s) => s.activePanelTab);
  const playbackActive = useSolixStore((s) => s.playback.active);
  const exitPlayback = useSolixStore((s) => s.exitPlayback);
  const orgs = useSolixStore((s) => s.orgs);
  const currentOrgId = useSolixStore((s) => s.currentOrgId);
  const planets = useSolixStore(selectPlanets);

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
    <header
      data-topbar=""
      className="absolute top-0 right-0 z-30 flex items-center gap-3 border-b border-solix-border bg-solix-panel/80 px-4 backdrop-blur-md"
      style={{ left: RAIL_WIDTH_PX, height: TOP_BAR_HEIGHT_PX }}
    >
      <Breadcrumb
        viewMode={viewMode}
        activePanel={activePanel}
        activePanelTab={activePanelTab}
      />

      <div className="flex-1" />

      {playbackActive && (
        <button
          onClick={exitPlayback}
          className="rounded border border-solix-accent px-2 py-0.5 text-[10px] text-solix-accent solix-pulse hover:bg-solix-accent/15"
          title="Exit Timeline Playback (Esc)"
          aria-label="Exit playback"
        >
          ▸ PLAYBACK · exit ✕
        </button>
      )}

      {activeOrg && orgs.length > 1 && (
        <span
          title="Active org — scopes which plans you see. Change it in Fleet › Orgs."
          className="select-none text-[11px] text-slate-500"
        >
          ◭ {activeOrg.name}
        </span>
      )}

      {/* Plain text, not bordered pills. The pills had the same base classes
          as a real button, so three readouts looked clickable and weren't. */}
      <div
        className="hidden items-center gap-3 text-[11px] sm:flex"
        aria-label="Fleet status"
      >
        <Stat value={counts.active} label="active" color="text-solix-ok" />
        <Stat
          value={counts.attention}
          label="need you"
          color={counts.attention > 0 ? 'text-solix-warn' : 'text-slate-500'}
        />
        <Stat value={counts.idle} label="idle" color="text-slate-500" />
      </div>

      <ConnectionDot />
    </header>
  );
}

function Stat({
  value,
  label,
  color,
}: {
  value: number;
  label: string;
  color: string;
}): JSX.Element {
  return (
    <span className="whitespace-nowrap">
      <span className={`font-semibold ${color}`}>{value}</span>
      <span className="ml-1 text-slate-500">{label}</span>
    </span>
  );
}

const PANEL_LABELS: Record<string, string> = {
  session: 'Agent',
  advisor: 'Advisor',
  skill: 'Skill',
  workspace: 'Mission Control',
  plan: 'Maestro',
  share: 'Share',
  fleet: 'Fleet',
};

const VIEW_LABELS: Record<string, string> = {
  galaxy: 'Galaxy',
  list: 'List',
  missions: 'Missions',
};

/** Says where you are. Nothing in the old bar did. */
function Breadcrumb({
  viewMode,
  activePanel,
  activePanelTab,
}: {
  viewMode: string;
  activePanel: string | null;
  activePanelTab: string | null;
}): JSX.Element {
  const crumbs: string[] = [VIEW_LABELS[viewMode] ?? viewMode];
  if (activePanel) {
    crumbs.push(PANEL_LABELS[activePanel] ?? activePanel);
    if (activePanel === 'fleet') {
      crumbs.push(
        (activePanelTab ?? 'crew').replace(/^./, (c) => c.toUpperCase()),
      );
    }
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-slate-400">
      {crumbs.map((c, i) => (
        <span key={c} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-slate-600">›</span>}
          <span className={i === crumbs.length - 1 ? 'text-slate-200' : ''}>
            {c}
          </span>
        </span>
      ))}
    </div>
  );
}
