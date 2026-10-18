import type { ReactNode } from 'react';
import { TOP_BAR_HEIGHT_PX } from './surfaces.js';

/**
 * A full-width working area.
 *
 * The counterpart to `RightDock`. Mission Control, Maestro, Share and Fleet
 * are places you work rather than things you glance at, and a 480px column
 * was the wrong container for all of them — Fleet's six sections truncated
 * in a tab strip, Crew cards stacked one per row forever, and Maestro's
 * diffs had nowhere to go.
 *
 * Panels keep their own structure; only the shell differs, so moving one
 * between a dock and a surface is a one-line change rather than a rewrite.
 */
export function Surface({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div
      data-workspace-surface=""
      className={`absolute inset-x-0 bottom-0 z-20 flex flex-col bg-solix-bg ${className}`}
      // Starts below the top bar rather than under it: the bar is
      // translucent over the galaxy, but a surface is opaque content and
      // would otherwise slide beneath the breadcrumb.
      style={{ top: TOP_BAR_HEIGHT_PX }}
    >
      {/* Full width is room to work, not licence to stretch a sentence to
          1400px. The column caps and centres so the header and the body
          share one left edge, and prose stays readable while card grids
          still get several columns. */}
      <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
