import { useSolixStore } from '../../store/index.js';
import { PanelHeader, RightDock, TabButton } from '../RightDock.js';
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
const TABS = [
  { id: 'crew', label: 'Crew' },
  { id: 'skills', label: 'Skills' },
  { id: 'teams', label: 'Teams' },
  { id: 'routines', label: 'Routines' },
  { id: 'connections', label: 'Connections' },
  { id: 'orgs', label: 'Orgs' },
] as const;

export type FleetTabId = (typeof TABS)[number]['id'];

const DEFAULT_TAB: FleetTabId = 'crew';

function isFleetTab(v: string | null): v is FleetTabId {
  return TABS.some((t) => t.id === v);
}

export function FleetPanel({ open }: { open: boolean }): JSX.Element | null {
  const activePanelTab = useSolixStore((s) => s.activePanelTab);
  const openPanel = useSolixStore((s) => s.openPanel);
  const closePanel = useSolixStore((s) => s.closePanel);

  if (!open) return null;

  const tab: FleetTabId = isFleetTab(activePanelTab)
    ? activePanelTab
    : DEFAULT_TAB;

  return (
    <RightDock>
      <PanelHeader
        eyebrow="fleet"
        title="Fleet"
        onClose={closePanel}
      >
        Who works for you, what they can use, and what runs on a schedule.
      </PanelHeader>
      <div className="flex text-xs border-b border-solix-border shrink-0 overflow-x-auto">
        {TABS.map((t) => (
          <TabButton
            key={t.id}
            active={tab === t.id}
            onClick={() => openPanel('fleet', t.id)}
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
    </RightDock>
  );
}
