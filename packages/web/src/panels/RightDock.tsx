import type { ReactNode } from 'react';
import { RIGHT_DOCK_WIDTH_PX } from './dock.js';

/**
 * The right-dock shell. Owns the chrome that was copy-pasted across seven
 * panels — position, background, border, blur, column layout, z-index — and
 * applies the one width from `dock.ts`.
 *
 * Width is an inline style on purpose: a Tailwind arbitrary value can't be
 * derived from a constant, so keeping `w-[480px]` would keep the duplication
 * between the CSS and the offset math that positions the Decision Queue.
 */
export function RightDock({
  children,
  className = '',
  layer = 'config',
}: {
  children: ReactNode;
  className?: string;
  /**
   * Contextual panels (opened by clicking a 3D object) sit BELOW the Decision
   * Queue; deliberate panels sit level with it. Kept as a distinction because
   * a pending permission request must never be covered by a panel the user
   * opened incidentally by clicking the scene.
   */
  layer?: 'contextual' | 'config';
}): JSX.Element {
  return (
    <div
      data-dock-panel=""
      className={`absolute top-16 bottom-0 right-0 bg-solix-panel border-l border-solix-border backdrop-blur-md flex flex-col ${
        layer === 'contextual' ? 'z-20' : 'z-30'
      } ${className}`}
      style={{ width: RIGHT_DOCK_WIDTH_PX }}
    >
      {children}
    </div>
  );
}

/**
 * Panel header with a title block and a close button.
 * Every panel hand-rolled this, and three of them forgot the aria-label.
 */
export function PanelHeader({
  eyebrow,
  title,
  children,
  onClose,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  /** Supporting copy under the title. */
  children?: ReactNode;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="px-5 py-4 border-b border-solix-border flex items-start justify-between shrink-0">
      <div className="min-w-0">
        {eyebrow && (
          <div className="text-xs uppercase tracking-widest text-solix-accent">
            {eyebrow}
          </div>
        )}
        <div className="text-lg font-semibold mt-0.5">{title}</div>
        {children && (
          <div className="text-xs text-slate-400 mt-1 leading-snug">
            {children}
          </div>
        )}
      </div>
      <button
        onClick={onClose}
        className="text-slate-400 hover:text-slate-100 shrink-0 ml-2"
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  );
}

/**
 * Tab strip button. This existed byte-identically in SharePanel and
 * SidePanel; the Fleet panel would have been a third copy.
 */
export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-3 py-2 ${
        active
          ? 'text-solix-accent border-b-2 border-solix-accent'
          : 'text-slate-400 hover:text-slate-200 border-b-2 border-transparent'
      }`}
    >
      {children}
    </button>
  );
}
