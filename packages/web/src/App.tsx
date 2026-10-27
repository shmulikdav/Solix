import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { ListView } from './hud/ListView.js';
import { MissionView } from './hud/MissionView.js';
import { TopBar } from './hud/TopBar.js';
import { Toasts } from './hud/Toasts.js';
import { Welcome } from './hud/Welcome.js';
import { HelpPanel } from './hud/HelpPanel.js';
import { NavRail } from './shell/NavRail.js';
import {
  RAIL_WIDTH_PX,
  TOP_BAR_HEIGHT_PX,
  type FleetTabId,
  type WorkspaceSurface,
} from './shell/surfaces.js';
import { FirstSunHint } from './hud/FirstSunHint.js';
import { CommandPalette } from './shell/CommandPalette.js';
import { ReportProblem } from './shell/ReportProblem.js';
import { readDismissed } from './hud/onboarding.js';
import { DecisionQueue } from './hud/DecisionQueue.js';
import { SceneControls } from './hud/SceneControls.js';
import { UpdateBanner } from './hud/UpdateBanner.js';
import {
  panDown,
  panLeft,
  panRight,
  panUp,
  reset as cameraReset,
  zoomIn as cameraZoomIn,
  zoomOut as cameraZoomOut,
} from './scene/cameraControls.js';
import { SidePanel } from './panels/SidePanel.js';
import { AdvisorPanel } from './panels/AdvisorPanel.js';
import { SkillPanel } from './panels/SkillPanel.js';
import { NewTaskModal } from './panels/NewTaskModal.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import {
  selectCanResolveByKey,
  selectDockOffsetPx,
  selectPendingPermissionsOrdered,
  useSolixStore,
} from './store/index.js';
import { startWsClient } from './ws/client.js';

// Sprint K code-split: the 3D galaxy scene pulls three.js, drei, and
// postprocessing — together the largest chunk of the bundle. Lazy-load
// it so a user who lands directly on List view doesn't pay that cost.
// Same for the Timeline drawer (only opened on demand) and the Galaxy
// panel (which has its own fetch + state).
const Scene = lazy(() =>
  import('./scene/Scene.js').then((m) => ({ default: m.Scene })),
);
const TimelineDrawer = lazy(() =>
  import('./hud/TimelineDrawer.js').then((m) => ({ default: m.TimelineDrawer })),
);
const SharePanel = lazy(() =>
  import('./panels/SharePanel.js').then((m) => ({ default: m.SharePanel })),
);
const WorkspacePanel = lazy(() =>
  import('./panels/WorkspacePanel.js').then((m) => ({
    default: m.WorkspacePanel,
  })),
);
const PlanPanel = lazy(() =>
  import('./panels/PlanPanel.js').then((m) => ({ default: m.PlanPanel })),
);
const FleetPanel = lazy(() =>
  import('./panels/fleet/FleetPanel.js').then((m) => ({
    default: m.FleetPanel,
  })),
);

export default function App(): JSX.Element {
  // Centred modals and the bottom drawer legitimately coexist with a dock
  // panel, so they stay local. Everything that occupies the right dock goes
  // through the store's `activePanel` instead.
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  // Mirrors Welcome's own gate so the sun hint can wait its turn.
  const [welcomeOpen, setWelcomeOpen] = useState(() => !readDismissed());
  // Welcome reads the dismissed flag once into its own state, so re-showing
  // it means remounting. Bumping this key is how "Show the welcome again"
  // works after clearDismissed() has removed the flag.
  const [welcomeNonce, setWelcomeNonce] = useState(0);

  const activePanel = useSolixStore((s) => s.activePanel);
  const openPanel = useSolixStore((s) => s.openPanel);
  const closePanel = useSolixStore((s) => s.closePanel);
  // One derived number instead of an if-chain that re-stated three CSS widths
  // and assumed a single panel was open. A wrong value here can push the
  // Decision Queue behind a panel and hide a pending permission request.
  const panelOffsetPx = useSolixStore(selectDockOffsetPx);

  const decisionsOpen = activePanel === 'decisions';
  const surface = useSolixStore((s) => s.workspaceSurface);
  const openSurface = useSolixStore((s) => s.openSurface);
  const closeSurface = useSolixStore((s) => s.closeSurface);
  const openFleet = (tab?: string): void =>
    openSurface({ kind: 'fleet', tab: (tab as FleetTabId) ?? 'crew' });

  useEffect(() => {
    startWsClient();
    void useSolixStore.getState().loadOrgs();
  }, []);

  /**
   * The keymap is registered once, so it cannot read `welcomeOpen` directly
   * without capturing the first value forever.
   */
  const welcomeOpenRef = useRef(welcomeOpen);
  welcomeOpenRef.current = welcomeOpen;

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Nothing here fires while the welcome modal is up.
      //
      // It covers the whole window including the rail, and every one of
      // these shortcuts ran behind it: `l` opened New Task under the
      // backdrop, `v` changed a view nobody could see, `t` dropped a
      // first-time user into Timeline playback. Worst was the pair the
      // modal itself advertises — pressing `?` (its own footer says "Press
      // ? any time") opened Help on top, and the single Escape that closed
      // Help also fired Welcome's listener and burned the first-run flag,
      // with no way back. Welcome.tsx's header claims that regression was
      // fixed by splitting the components; the split closed the button path
      // and left the key path open, and onboarding.test.tsx never mounts
      // the two together with this handler, which is why CI was green.
      if (welcomeOpenRef.current) return;

      const state = useSolixStore.getState();
      const target = e.target as HTMLElement | null;
      const isTextField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable === true;
      // A focused control owns its own keys. Space activates a button and
      // arrows move through a <select>; the galaxy shortcuts used to take
      // both, so tabbing to Approve and pressing Space toggled orbit motion
      // on a scene behind a modal and did not press the button. SELECT is
      // in isTextField above for the same reason — typing a letter to jump
      // to an option was opening Maestro.
      const onControl =
        target?.tagName === 'BUTTON' ||
        target?.tagName === 'A' ||
        target?.getAttribute?.('role') === 'button';
      const inGalaxy = state.viewMode === 'galaxy';
      // Must match what the Decision Queue shows: `Y`/`N` act on the card the
      // user is actually looking at. Both read one selector so they cannot
      // drift apart again.
      const top = selectPendingPermissionsOrdered(state)[0];
      const decisionsVisible = selectCanResolveByKey(state);

      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        // One call closes whichever dock panel is open — previously this had
        // to enumerate every panel, and adding one meant remembering to add it
        // here too.
        // Escape closes the nearest thing: a contextual dock first, then
        // the surface underneath it. Closing both at once would throw away
        // more than the user asked for.
        if (state.activePanel) state.closePanel();
        else state.closeSurface();
        setNewTaskOpen(false);
        setHelpOpen(false);
        // Esc also exits Timeline Playback — the only mode where the rest of
        // the UI feels frozen because state is derived from past events.
        // Cheap escape hatch when the "× Live" button isn't clickable for
        // any reason (e.g. a third-party window overlay).
        if (state.playback.active) {
          state.exitPlayback();
          setTimelineOpen(false);
        }
      } else if (!isTextField && e.key === '?') {
        setHelpOpen((v) => !v);
      } else if (!isTextField && (e.key === 'g' || e.key === 'G')) {
        if (state.workspaceSurface?.kind === 'share') state.closeSurface();
        else state.openSurface({ kind: 'share' });
      } else if (!isTextField && (e.key === 'c' || e.key === 'C')) {
        // C still means crew, but crew is a Fleet section now, so the key
        // toggles Fleet-on-crew rather than a separate modal.
        const f = state.workspaceSurface;
        if (f?.kind === 'fleet' && f.tab === 'crew') state.closeSurface();
        else state.openSurface({ kind: 'fleet', tab: 'crew' });
      } else if (!isTextField && (e.key === 'p' || e.key === 'P')) {
        if (state.workspaceSurface?.kind === 'plan') state.closeSurface();
        else state.openSurface({ kind: 'plan' });
      } else if (!isTextField && (e.key === 'l' || e.key === 'L')) {
        setNewTaskOpen(true);
        // Camera + motion keys only do something in the galaxy view. They were
        // bound in List and Missions too, where there is no camera and nothing
        // orbits — pressing them silently did nothing.
      } else if (!isTextField && inGalaxy && (e.key === '+' || e.key === '=')) {
        cameraZoomIn();
      } else if (!isTextField && inGalaxy && e.key === '-') {
        cameraZoomOut();
      } else if (!isTextField && inGalaxy && e.key === '0') {
        cameraReset();
      } else if (!isTextField && inGalaxy && e.key === 'ArrowLeft') {
        panLeft();
      } else if (!isTextField && inGalaxy && e.key === 'ArrowRight') {
        panRight();
      } else if (!isTextField && inGalaxy && e.key === 'ArrowUp') {
        panUp();
      } else if (!isTextField && inGalaxy && e.key === 'ArrowDown') {
        panDown();
      } else if (!isTextField && !onControl && inGalaxy && e.key === ' ') {
        e.preventDefault();
        state.toggleMotion();
      } else if (!isTextField && (e.key === 'v' || e.key === 'V')) {
        state.toggleViewMode();
      } else if (!isTextField && (e.key === 'm' || e.key === 'M')) {
        state.setViewMode('missions');
      } else if (!isTextField && (e.key === 't' || e.key === 'T')) {
        setTimelineOpen((v) => !v);
      } else if (!isTextField && (e.key === 'w' || e.key === 'W')) {
        if (state.workspaceSurface?.kind === 'overview') state.closeSurface();
        else state.openSurface({ kind: 'overview' });
      } else if (
        !isTextField &&
        top &&
        decisionsVisible &&
        (e.key === 'y' || e.key === 'Y')
      ) {
        state.resolvePermission(top.requestId, true);
      } else if (
        !isTextField &&
        top &&
        decisionsVisible &&
        (e.key === 'n' || e.key === 'N')
      ) {
        state.resolvePermission(top.requestId, false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative h-full w-full">
      {/* The main area starts after the rail. Everything absolutely positioned
          inside it — the canvas, the docks, the queue — is measured from this
          box rather than from the window, so there is one place that knows the
          rail exists. */}
      <div
        className="absolute inset-y-0 right-0"
        style={{ left: RAIL_WIDTH_PX }}
      >
        {/* One of these, never both: a surface replaces the canvas rather
            than covering it, which is what makes Fleet and Maestro usable at
            full width. Contextual docks still float over whichever is up. */}
        {surface ? (
          <Suspense fallback={null}>
            <WorkspaceSurfaces surface={surface} onClose={closeSurface} />
          </Suspense>
        ) : (
          <ViewSurface />
        )}
      </div>
      <NavRail
        onNewTask={() => setNewTaskOpen(true)}
        onOpenTimeline={() => setTimelineOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onReportProblem={() => setReportOpen(true)}
      />
      <TopBar />
      {decisionsOpen && <DecisionQueue />}
      <SidePanel />
      <AdvisorPanel />
      <SkillPanel />
      <NewTaskModal
        open={newTaskOpen}
        onClose={() => setNewTaskOpen(false)}
      />
      {timelineOpen && (
        <Suspense fallback={null}>
          <TimelineDrawer
            open={timelineOpen}
            onClose={() => setTimelineOpen(false)}
          />
        </Suspense>
      )}
      <SceneControls />
      {/* Two components now, not one. Help used to BE Welcome with a
          forceOpen flag, and closing it wrote the first-run dismissed flag —
          so pressing ? once consumed a new user's onboarding. */}
      <Welcome
        key={welcomeNonce}
        onPlanBuild={() => openSurface({ kind: 'plan' })}
        onOpenCrew={() => openFleet('crew')}
        onDismissed={() => setWelcomeOpen(false)}
      />
      <HelpPanel
        open={helpOpen}
        onClose={() => setHelpOpen(false)}
        onShowWelcome={() => {
          setWelcomeOpen(true);
          setWelcomeNonce((n) => n + 1);
        }}
      />
      <ReportProblem open={reportOpen} onClose={() => setReportOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNewTask={() => setNewTaskOpen(true)}
        onOpenTimeline={() => setTimelineOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onReportProblem={() => setReportOpen(true)}
      />
      <FirstSunHint suppressed={welcomeOpen || helpOpen || paletteOpen} />
      <Toasts />
      <EmptyHint />
      <UpdateBanner />
    </div>
  );
}

/**
 * Renders either the 3D galaxy or the table list view, depending on the
 * persisted viewMode. The TopBar / DecisionQueue / panels overlay both.
 */
/** Routes the active workspace surface to its component. */
function WorkspaceSurfaces({
  surface,
  onClose,
}: {
  surface: WorkspaceSurface;
  onClose: () => void;
}): JSX.Element {
  switch (surface.kind) {
    case 'overview':
      return <WorkspacePanel open onClose={onClose} />;
    case 'plan':
      return <PlanPanel open onClose={onClose} />;
    case 'share':
      return <SharePanel open onClose={onClose} />;
    case 'fleet':
      return <FleetPanel open />;
  }
}

function ViewSurface(): JSX.Element {
  const viewMode = useSolixStore((s) => s.viewMode);
  if (viewMode === 'list') return <ListView />;
  if (viewMode === 'missions') return <MissionView />;
  // The 3D galaxy chunk is loaded on demand. Show a quiet loader so
  // the screen doesn't go blank during the ~hundreds-of-ms first
  // paint while three.js downloads.
  return (
    // Defense in depth: whatever happens inside the 3D scene (a bad asset, a
    // driver quirk, a WebGL context failure), it must never take the HUD and
    // panels down with it. Without this, one throw inside the canvas unmounted
    // the entire app and the user got a black page with no way back.
    <ErrorBoundary label="galaxy scene" fallback={<SceneUnavailable />}>
      <Suspense fallback={<SceneLoading />}>
        <Scene />
      </Suspense>
    </ErrorBoundary>
  );
}

/** Shown when the 3D scene itself fails — the rest of the UI keeps working. */
function SceneUnavailable(): JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-solix-bg z-0">
      <div className="text-center text-xs text-slate-500 max-w-xs leading-relaxed">
        <div className="text-slate-300 mb-1">The galaxy view didn’t load.</div>
        Your agents are still running.
        {/* Previously this told the user to switch view but rendered no way to
            do it — the only path was the top bar behind this overlay. */}
        <div className="mt-3 flex items-center justify-center gap-2">
          <button
            onClick={() => useSolixStore.getState().setViewMode('list')}
            className="px-2 py-1 rounded border border-solix-border text-slate-300 hover:bg-solix-border/30 hover:text-white"
          >
            Switch to List
          </button>
          <button
            onClick={() => useSolixStore.getState().setViewMode('missions')}
            className="px-2 py-1 rounded border border-solix-border text-slate-300 hover:bg-solix-border/30 hover:text-white"
          >
            Missions
          </button>
          <button
            onClick={() => window.location.reload()}
            className="px-2 py-1 rounded border border-solix-border text-slate-300 hover:bg-solix-border/30 hover:text-white"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}

function SceneLoading(): JSX.Element {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-solix-bg z-0">
      <div className="text-xs text-slate-500 uppercase tracking-widest solix-pulse">
        loading galaxy…
      </div>
    </div>
  );
}

function EmptyHint(): JSX.Element | null {
  const sessionCount = useSolixStore(
    (s) => Object.keys(s.sessions).length,
  );
  const connected = useSolixStore((s) => s.connected);
  if (sessionCount > 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center z-10">
      <div className="rounded-lg border border-solix-border bg-solix-panel p-6 max-w-md text-center backdrop-blur">
        <div className="text-sm uppercase tracking-widest text-solix-accent">
          empty system
        </div>
        <div className="mt-2 text-slate-200">
          {connected
            ? 'Run `claude` in any terminal — the planet will appear here.'
            : 'Waiting for the Solix server…'}
        </div>
        <div className="mt-3 text-xs text-slate-500">
          The sun is mission control. Each agent orbits it as a planet.
        </div>
      </div>
    </div>
  );
}
