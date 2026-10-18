import { useSolixStore } from '../../store/index.js';
import { FLEET_SECTIONS, type FleetTabId } from '../../shell/surfaces.js';
import { PanelHeader } from '../RightDock.js';
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
/**
 * The tab strip is gone. The rail lists these six sections as rows, so a
 * strip inside the panel was the same navigation twice — and the second copy
 * was the one that truncated "Connections" at 480px.
 *
 * What the header shows instead is which section you are in and what it is
 * for, which the strip never said.
 */
const SECTION_TITLES: Record<FleetTabId, string> = {
  crew: 'Crew',
  skills: 'Skills',
  teams: 'Teams',
  routines: 'Routines',
  connections: 'Connections',
  orgs: 'Orgs',
};

const SECTION_BLURBS: Record<FleetTabId, string> = {
  crew: 'Advisors that watch your fleet. Enabling one is free; pinning or invoking it costs tokens.',
  skills: 'Reusable instructions you can attach to agents. Writing one is free.',
  teams: 'Ready-made advisor, skill and routine bundles you can install into a project in one click.',
  routines: 'Recurring agent runs. Each one starts a real session and costs money until you disable it.',
  connections: 'API keys and secrets, write-only and encrypted, granted to the agents you choose.',
  orgs: 'Keep separate work separate. Orgs scope which plans you see, and stay on this machine.',
};

const DEFAULT_TAB: FleetTabId = 'crew';

function isFleetTab(v: string | null): v is FleetTabId {
  return FLEET_SECTIONS.some((t) => t.id === v);
}

export function FleetPanel({ open }: { open: boolean }): JSX.Element | null {
  const surface = useSolixStore((s) => s.workspaceSurface);
  const closeSurface = useSolixStore((s) => s.closeSurface);

  if (!open) return null;

  const current = surface?.kind === 'fleet' ? surface.tab : null;
  const tab: FleetTabId = isFleetTab(current) ? current : DEFAULT_TAB;

  return (
    <Surface>
      <PanelHeader
        eyebrow="fleet"
        title={SECTION_TITLES[tab]}
        onClose={closeSurface}
      >
        {SECTION_BLURBS[tab]}
      </PanelHeader>
      {tab === 'crew' && <CrewTab open />}
      {tab === 'connections' && <ConnectionsTab open />}
      {tab === 'teams' && <TeamsTab open />}
      {tab === 'routines' && <RoutinesTab open />}
      {tab === 'skills' && <SkillsTab />}
      {tab === 'orgs' && <OrgsTab />}
    </Surface>
  );
}
