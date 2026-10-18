/**
 * The right dock — one identity list, one width.
 *
 * Before this, panel geometry was duplicated three ways: the CSS class on each
 * panel (`w-[420px]` / `w-[460px]` / `w-full sm:w-[480px]`), a hardcoded
 * if-chain in App.tsx that re-stated those numbers to offset the Decision
 * Queue, and the implicit assumption that only one panel was open. They drifted,
 * and the drift was not cosmetic: the Decision Queue is positioned purely by
 * that offset, shares z-30 with the dock panels, and renders before them — so a
 * wrong offset could put a pending permission request behind an opaque panel.
 * Permission requests are what unblock stuck agents.
 *
 * The width is applied as an inline style by `RightDock`, deliberately: a
 * Tailwind arbitrary value can't be derived from a constant (the JIT can't see
 * `w-[${n}px]`), so any scheme that keeps the class keeps the duplication.
 */

/** Every surface that can occupy the right dock. At most one is open. */
export type PanelId =
  // contextual — opened by clicking something in the 3D scene
  | 'session'
  | 'advisor'
  | 'skill'
  // deliberate — opened from the top bar or a shortcut
  | 'workspace'
  | 'plan'
  // Export / import / versions / audit. Named 'share' rather than 'galaxy'
  // because that word already means the 3D view mode.
  | 'share'
  // The six configuration surfaces, behind one door and one tab strip.
  | 'fleet';

export const RIGHT_DOCK_WIDTH_PX = 480;
