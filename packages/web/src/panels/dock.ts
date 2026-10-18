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

/**
 * Every surface that can occupy the right dock. At most one is open.
 *
 * Deliberately short. Mission Control, Maestro, Share and Fleet used to be in
 * here, and being a 480px column was wrong for all four — they are places you
 * work, so they became `WorkspaceSurface` and take the whole main area. What
 * is left is the things that belong *beside* the scene: the three opened by
 * clicking a 3D object, and the decision queue, which you want in view while
 * you watch the galaxy it is reporting on.
 */
export type PanelId =
  // contextual — opened by clicking something in the 3D scene
  | 'session'
  | 'advisor'
  | 'skill'
  // pending permissions, opened from the rail
  | 'decisions';

export const RIGHT_DOCK_WIDTH_PX = 480;
