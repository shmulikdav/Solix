import { lazy, Suspense, useEffect, useState } from 'react';
import { ListView } from './hud/ListView.js';
import { MissionView } from './hud/MissionView.js';
import { TopBar } from './hud/TopBar.js';
import { Toasts } from './hud/Toasts.js';
import { Welcome } from './hud/Welcome.js';
import { HelpPanel } from './hud/HelpPanel.js';
import { FirstSunHint } from './hud/FirstSunHint.js';
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
  // Mirrors Welcome's own gate so the sun hint can wait its turn.
  const [welcomeOpen, setWelcomeOpen] = useState(() => !readDismissed());

  const activePanel = useSolixStore((s) => s.activePanel);
  const openPanel = useSolixStore((s) => s.openPanel);
  const closePanel = useSolixStore((s) => s.closePanel);
  // One derived number instead of an if-chain that re-stated three CSS widths
  // and assumed a single panel was open. A wrong value here can push the
  // Decision Queue behind a panel and hide a pending permission request.
  const panelOffsetPx = useSolixStore(selectDockOffsetPx);

  const shareOpen = activePanel === 'share';
  const fleetOpen = activePanel === 'fleet';
  const workspaceOpen = activePanel === 'workspace';
  const planPanelOpen = activePanel === 'plan';
  const setShareOpen = (v: boolean): void =>
    v ? openPanel('share') : closePanel();
  const openFleet = (tab?: string): void => openPanel('fleet', tab);
  const closeWorkspace = (): void => closePanel();
  const openPlanPanel = (): void => openPanel('plan');
  const closePlanPanel = (): void => closePanel();

  useEffect(() => {
    startWsClient();
    void useSolixStore.getState().loadOrgs();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const state = useSolixStore.getState();
      const target = e.target as HTMLElement | null;
      const isTextField =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;
      const inGalaxy = state.viewMode === 'galaxy';
      // Must match what the Decision Queue shows: `Y`/`N` act on the card the
      // user is actually looking at. Both read one selector so they cannot
      // drift apart again.
      const top = selectPendingPermissionsOrdered(state)[0];

      if (e.key === 'Escape') {
        // One call closes whichever dock panel is open — previously this had
        // to enumerate every panel, and adding one meant remembering to add it
        // here too.
        state.closePanel();
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
        if (state.activePanel === 'share') state.closePanel();
        else state.openPanel('share');
      } else if (!isTextField && (e.key === 'c' || e.key === 'C')) {
        // C still means crew, but crew is a Fleet tab now, so the key toggles
        // Fleet-on-crew rather than a separate modal.
        if (state.activePanel === 'fleet' && state.activePanelTab === 'crew') {
          state.closePanel();
        } else {
          state.openPanel('fleet', 'crew');
        }
      } else if (!isTextField && (e.key === 'p' || e.key === 'P')) {
        if (state.activePanel === 'plan') state.closePanel();
        else state.openPanel('plan');
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
      } else if (!isTextField && inGalaxy && e.key === ' ') {
        e.preventDefault();
        state.toggleMotion();
      } else if (!isTextField && (e.key === 'v' || e.key === 'V')) {
        state.toggleViewMode();
      } else if (!isTextField && (e.key === 'm' || e.key === 'M')) {
        state.setViewMode('missions');
      } else if (!isTextField && (e.key === 't' || e.key === 'T')) {
        setTimelineOpen((v) => !v);
      } else if (!isTextField && (e.key === 'w' || e.key === 'W')) {
        if (state.activePanel === 'workspace') state.closePanel();
        else state.openPanel('workspace');
      } else if (!isTextField && top && (e.key === 'y' || e.key === 'Y')) {
        state.resolvePermission(top.requestId, true);
      } else if (!isTextField && top && (e.key === 'n' || e.key === 'N')) {
        state.resolvePermission(top.requestId, false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative h-full w-full">
      <ViewSurface />
      <TopBar
        onOpenShare={() => setShareOpen(true)}
        onNewTask={() => setNewTaskOpen(true)}
        onOpenTimeline={() => setTimelineOpen(true)}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenPlan={openPlanPanel}
        onOpenFleet={() => openFleet()}
        onOpenWorkspace={() => openPanel('workspace')}
      />
      <DecisionQueue panelOffsetPx={panelOffsetPx} />
      <SidePanel />
      <AdvisorPanel />
      <SkillPanel />
      {shareOpen && (
        <Suspense fallback={null}>
          <SharePanel open={shareOpen} onClose={() => setShareOpen(false)} />
        </Suspense>
      )}
      {workspaceOpen && (
        <Suspense fallback={null}>
          <WorkspacePanel open={workspaceOpen} onClose={closeWorkspace} />
        </Suspense>
      )}
      {planPanelOpen && (
        <Suspense fallback={null}>
          <PlanPanel open={planPanelOpen} onClose={closePlanPanel} />
        </Suspense>
      )}
      {fleetOpen && (
        <Suspense fallback={null}>
          <FleetPanel open={fleetOpen} />
        </Suspense>
      )}
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
        onPlanBuild={() => openPanel('plan')}
        onOpenCrew={() => openFleet('crew')}
        onDismissed={() => setWelcomeOpen(false)}
      />
      <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />
      <FirstSunHint suppressed={welcomeOpen || helpOpen} />
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
