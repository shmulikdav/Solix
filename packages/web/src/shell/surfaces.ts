import type { PanelId } from '../panels/dock.js';

/**
 * The navigation shell.
 *
 * Everything used to live in one 44px horizontal strip: identity, live status,
 * the view switch, and seven destinations — two of which have their own
 * sub-tabs. That is four unrelated jobs in one row, which is why the bar kept
 * wrapping however much width was shaved off it. Material Design 3 puts the
 * ceiling for a horizontal nav at five destinations; the general guidance is a
 * sidebar as soon as a product has any depth. Solix is well past both.
 *
 * So destinations move to a left rail, grouped by the job they serve — watch
 * the fleet, build with it, govern it — which is a distinction the flat bar
 * could never express.
 */
export const RAIL_WIDTH_PX = 220;

/** Height of the slim top strip above the main area. */
export const TOP_BAR_HEIGHT_PX = 44;

export type RailGroup = 'watch' | 'build' | 'govern';

export interface RailItem {
  id: string;
  label: string;
  glyph: string;
  group: RailGroup;
  /** Shortcut shown on the right of the row, if it has one. */
  hint?: string;
  /** Sub-items, rendered nested when this row is the active one. */
  children?: Array<{ id: string; label: string }>;
}

export const RAIL_GROUPS: Array<{ id: RailGroup; label: string }> = [
  { id: 'watch', label: 'Watch' },
  { id: 'build', label: 'Build' },
  { id: 'govern', label: 'Govern' },
];

/**
 * Fleet's sections. These were a six-tab strip inside a 480px dock, where
 * "Connections" already truncated. As rail children they get a full row each.
 */
export const FLEET_SECTIONS = [
  { id: 'crew', label: 'Crew' },
  { id: 'skills', label: 'Skills' },
  { id: 'teams', label: 'Teams' },
  { id: 'routines', label: 'Routines' },
  { id: 'connections', label: 'Connections' },
  { id: 'orgs', label: 'Orgs' },
] as const;

export const RAIL_ITEMS: RailItem[] = [
  { id: 'galaxy', label: 'Galaxy', glyph: '🪐', group: 'watch', hint: 'V' },
  { id: 'list', label: 'List', glyph: '☰', group: 'watch' },
  { id: 'missions', label: 'Missions', glyph: '◎', group: 'watch', hint: 'M' },

  { id: 'task', label: 'New task', glyph: '＋', group: 'build', hint: 'L' },
  { id: 'plan', label: 'Maestro', glyph: '✷', group: 'build', hint: 'P' },

  { id: 'overview', label: 'Mission Control', glyph: '☀', group: 'govern', hint: 'W' },
  {
    id: 'fleet',
    label: 'Fleet',
    glyph: '⚙',
    group: 'govern',
    hint: 'C',
    children: FLEET_SECTIONS.map((s) => ({ id: s.id, label: s.label })),
  },
  { id: 'share', label: 'Share', glyph: '⌬', group: 'govern', hint: 'G' },
  { id: 'timeline', label: 'Timeline', glyph: '⏱', group: 'govern', hint: 'T' },
];

/** Rail ids that map onto a dock panel, for highlighting the active row. */
export const RAIL_ID_TO_PANEL: Partial<Record<string, PanelId>> = {
  plan: 'plan',
  overview: 'workspace',
  fleet: 'fleet',
  share: 'share',
};
