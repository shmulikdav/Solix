import { useSolixStore } from '../../store/index.js';
import { FLEET_SECTIONS, type FleetTabId } from '../../shell/surfaces.js';
import { PanelHeader, TabButton } from '../RightDock.js';
import { Surface } from '../../shell/Surface.js';
import { ConnectionsTab } from './ConnectionsTab.js';
import { CrewTab } from './CrewTab.js';
import { OrgsTab } from './OrgsTab.js';
import { RoutinesTab } from './RoutinesTab.js';
import { SkillsTab } from './SkillsTab.js';
import { TeamsTab } from './TeamsTab.js';

/**
 * Fleet — one door for the six configuration surfaces that used to each own a
 * top-level button (or, in the case of Routines, no UI at all).
 *
 * Before this, the top bar carried Crew, Connections, Skill and an org select
 * alongside the things you actually do with the product, so configuration and
 * action competed for the same attention. Grouping them also means Routines
 * finally has somewhere to live: installing a team creates recurring,
 * money-spending schedules that previously could only be stopped from a
 * terminal.
 *
 * Each tab is `({ open }) => JSX` and renders only its own scroller; this panel
 * owns the dock shell, the header, the tab strip and the close button.
 */
// One definition of the section list, shared with the rail — a second copy
// here is how the rail and the panel end up offering different tabs.
const TABS = FLEET_SECTIONS;

const DEFAULT_TAB: FleetTabId = 'crew';

function isFleetTab(v: string | null): v is FleetTabId {
  return TABS.some((t) => t.id === v);
}

export function FleetPanel({ open }: { open: boolean }): JSX.Element | null {
  const surface = useSolixStore((s) => s.workspaceSurface);
  const openSurface = useSolixStore((s) => s.openSurface);
  const closeSurface = useSolixStore((s) => s.closeSurface);

  if (!open) return null;

  const current = surface?.kind === 'fleet' ? surface.tab : null;
  const tab: FleetTabId = isFleetTab(current) ? current : DEFAULT_TAB;

  return (
    <Surface>
      <PanelHeader
        eyebrow="fleet"
        title="Fleet"
        onClose={closeSurface}
      >
        Who works for you, what they can use, and what runs on a schedule.
      </PanelHeader>
      <div className="flex text-xs border-b border-solix-border shrink-0 overflow-x-auto">
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            active={tab === t.id}
            onClick={() => openSurface({ kind: 'fleet', tab: t.id })}
          >
            {t.label}
          </TabButton>
        ))}
      </div>
      {tab === 'crew' && <CrewTab open />}
      {tab === 'connections' && <ConnectionsTab open />}
      {tab === 'teams' && <TeamsTab open />}
      {tab === 'routines' && <RoutinesTab open />}
      {tab === 'skills' && <SkillsTab />}
      {tab === 'orgs' && <OrgsTab />}
    </Surface>
  );
}
