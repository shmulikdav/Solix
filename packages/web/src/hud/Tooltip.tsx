import { useId, useState, type ReactNode } from 'react';

/**
 * A small hover/focus tooltip.
 *
 * Everything else in the HUD uses a native `title=`, and should keep doing so:
 * those controls already show a glyph and a word, so the tooltip only adds
 * detail. This exists for the cases where the trigger has no visible label at
 * all — the connection dot — and the tooltip is therefore the only way to find
 * out what the thing is. A native title is wrong for that job: it waits about
 * a second before appearing, cannot be styled to match the panel, and wraps
 * two sentences badly.
 *
 * Opens on focus as well as hover, so a dot with no label is still reachable
 * without a mouse.
 */
export function Tooltip({
  content,
  children,
  align = 'start',
}: {
  content: ReactNode;
  children: (props: {
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
    'aria-describedby': string | undefined;
  }) => ReactNode;
  align?: 'start' | 'center';
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className="relative inline-flex">
      {children({
        onMouseEnter: () => setOpen(true),
        onMouseLeave: () => setOpen(false),
        onFocus: () => setOpen(true),
        onBlur: () => setOpen(false),
        'aria-describedby': open ? id : undefined,
      })}
      {open && (
        <span
          id={id}
          role="tooltip"
          className={`pointer-events-none absolute top-full mt-2 z-50 w-56 rounded border border-solix-border bg-solix-panel px-2.5 py-1.5 text-[11px] leading-snug text-slate-300 shadow-lg ${
            align === 'center' ? 'left-1/2 -translate-x-1/2' : 'left-0'
          }`}
        >
          {content}
        </span>
      )}
    </span>
  );
}
