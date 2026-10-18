import {
  selectPendingPermissionsOrdered,
  selectPlanets,
  useSolixStore,
} from '../store/index.js';
import {
  RAIL_GROUPS,
  RAIL_ID_TO_PANEL,
  RAIL_ITEMS,
  RAIL_WIDTH_PX,
  type RailItem,
} from './surfaces.js';

export interface NavRailProps {
  onNewTask: () => void;
  onOpenTimeline: () => void;
  onOpenHelp: () => void;
}

/**
 * The left navigation rail.
 *
 * Replaces nine controls crammed into a wrapping top bar. Destinations are
 * grouped by job rather than listed flat, Fleet can show its six sections as
 * nested rows instead of a truncating tab strip, and adding a surface costs a
 * row rather than another fight for horizontal space.
 */
export function NavRail({
  onNewTask,
  onOpenTimeline,
  onOpenHelp,
}: NavRailProps): JSX.Element {
  const viewMode = useSolixStore((s) => s.viewMode);
  const setViewMode = useSolixStore((s) => s.setViewMode);
  const activePanel = useSolixStore((s) => s.activePanel);
  const activePanelTab = useSolixStore((s) => s.activePanelTab);
  const openPanel = useSolixStore((s) => s.openPanel);
  const closePanel = useSolixStore((s) => s.closePanel);
  const planets = useSolixStore(selectPlanets);
  const pending = useSolixStore(selectPendingPermissionsOrdered).length;

  // Only the count that means "a human is needed" earns a badge. Active and
  // idle are context; attention is an instruction.
  const attention = planets.filter(
    (s) =>
      s.status === 'awaiting_permission' ||
      s.status === 'awaiting_input' ||
      s.status === 'plan_review',
  ).length;

  const isActive = (item: RailItem): boolean => {
    const panel = RAIL_ID_TO_PANEL[item.id];
    if (panel) return activePanel === panel;
    return viewMode === item.id && !activePanel;
  };

  const activate = (item: RailItem): void => {
    switch (item.id) {
      case 'galaxy':
      case 'list':
      case 'missions':
        // Choosing a view also dismisses whatever panel is covering it —
        // otherwise picking "List" leaves you looking at the same panel.
        closePanel();
        setViewMode(item.id);
        return;
      case 'task':
        onNewTask();
        return;
      case 'timeline':
        onOpenTimeline();
        return;
      default: {
        const panel = RAIL_ID_TO_PANEL[item.id];
        if (!panel) return;
        if (activePanel === panel) closePanel();
        else openPanel(panel);
      }
    }
  };

  return (
    <nav
      data-nav-rail=""
      aria-label="Main"
      className="absolute left-0 top-0 bottom-0 z-40 flex flex-col bg-black/40 backdrop-blur-xl"
      style={{ width: RAIL_WIDTH_PX }}
    >
      <div className="px-5 pt-5 pb-7 flex items-baseline gap-1.5 shrink-0">
        <span className="text-lg font-bold tracking-widest text-solix-accent">
          SOLIX
        </span>
        <span
          className="text-[10px] font-mono text-slate-500"
          title={`Solix v${__SOLIX_VERSION__}`}
        >
          v{__SOLIX_VERSION__}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4 space-y-7">
        {RAIL_GROUPS.map((group) => (
          <div key={group.id}>
            <div className="pb-2 text-[10px] uppercase tracking-[0.2em] text-slate-700">
              {group.label}
            </div>
            <div className="space-y-1">
              {RAIL_ITEMS.filter((i) => i.group === group.id).map((item) => {
                const active = isActive(item);
                const expanded = item.children != null && active;
                return (
                  <div key={item.id}>
                    {/* Weight and opacity carry the hierarchy — no fill, no
                        border, no icon. A filled accent block on the active
                        row reads as a button, which is the confusion this
                        redesign is trying to end. The shortcut moves to the
                        title so it is there when wanted and silent when not. */}
                    <button
                      onClick={() => activate(item)}
                      aria-current={active ? 'page' : undefined}
                      title={item.hint ? `${item.label}  (${item.hint})` : item.label}
                      className={`group w-full flex items-baseline gap-2 py-1.5 text-left transition-colors ${
                        item.id === 'decisions' && pending > 0 && !active
                          ? 'text-solix-warn solix-pulse'
                          : active
                            ? 'text-slate-50'
                            : 'text-slate-500 hover:text-slate-200'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`w-0.5 self-stretch shrink-0 rounded-full ${
                          active ? 'bg-solix-accent' : 'bg-transparent'
                        }`}
                      />
                      <span
                        className={`flex-1 truncate ${
                          active ? 'text-sm font-medium' : 'text-sm'
                        }`}
                      >
                        {item.label}
                      </span>
                      {item.id === 'galaxy' && attention > 0 && (
                        <span
                          className="shrink-0 text-xs font-semibold text-solix-warn"
                          title={`${attention} agent(s) need you`}
                        >
                          {attention}
                        </span>
                      )}
                      {item.id === 'decisions' && pending > 0 && (
                        <span
                          className="shrink-0 rounded-full bg-solix-warn px-1.5 text-[11px] font-semibold text-black"
                          title={`${pending} waiting on your approval`}
                        >
                          {pending}
                        </span>
                      )}
                    </button>

                    {expanded && item.children && (
                      <div className="mt-1 mb-1 ml-2.5 space-y-1 pl-3">
                        {item.children.map((child) => {
                          const childActive =
                            activePanelTab === child.id ||
                            (activePanelTab == null && child.id === 'crew');
                          return (
                            <button
                              key={child.id}
                              onClick={() =>
                                openPanel(
                                  RAIL_ID_TO_PANEL[item.id] ?? 'fleet',
                                  child.id,
                                )
                              }
                              aria-current={childActive ? 'page' : undefined}
                              className={`w-full py-0.5 text-left text-xs transition-colors ${
                                childActive
                                  ? 'text-solix-accent'
                                  : 'text-slate-600 hover:text-slate-300'
                              }`}
                            >
                              {child.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="px-5 py-4 shrink-0">
        <button
          onClick={onOpenHelp}
          title="Help  (?)"
          className="w-full py-1 text-left text-sm text-slate-600 transition-colors hover:text-slate-300"
        >
          Help
        </button>
      </div>
    </nav>
  );
}
