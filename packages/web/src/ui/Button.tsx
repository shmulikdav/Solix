import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * The one button.
 *
 * `variant` is the semantic palette the audit settled on, not a colour name —
 * call sites say what the button *does*, and the colour follows:
 *
 *   warn     spends money (starts an agent, extends a cap, installs routines)
 *   danger   stops or destroys something
 *   ok       free, or a success path
 *   primary  the one main action on a surface
 *   neutral  everything else, navigation included
 *   ghost    a text-weight action inside dense rows
 *
 * This exists for two reasons beyond tidiness. The `busy` prop owns a pattern
 * every call site was hand-rolling — `{busy ? 'Saving…' : 'Save'}` next to
 * `disabled={busy || …}` — where forgetting half of it gives you a button that
 * looks idle while it works, or stays clickable while it runs. And the
 * disabled style lives in one place; it was `opacity-40` in most panels and
 * `opacity-50` in others, for no reason anyone chose.
 */
export type ButtonVariant =
  | 'primary'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'neutral'
  | 'ghost';

export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-solix-accent/20 border border-solix-accent text-solix-accent hover:bg-solix-accent/30',
  ok: 'bg-solix-ok/15 border border-solix-ok/40 text-solix-ok hover:bg-solix-ok/25',
  warn: 'bg-solix-warn/20 border border-solix-warn/60 text-solix-warn hover:bg-solix-warn/30',
  danger:
    'bg-solix-danger/15 border border-solix-danger/60 text-solix-danger hover:bg-solix-danger/25',
  neutral:
    'bg-slate-500/15 border border-slate-400/40 text-slate-200 hover:bg-slate-500/25',
  ghost:
    'border border-solix-border text-slate-300 hover:text-white hover:bg-solix-border/30',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1 text-[11px]',
  md: 'px-3 py-1.5 text-xs',
};

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Disables the button and swaps the label for `busyLabel`. */
  busy?: boolean;
  /** Shown while `busy`. Defaults to an ellipsis. */
  busyLabel?: ReactNode;
  /** Stretches to the container's width. */
  block?: boolean;
  children: ReactNode;
}

export function Button({
  variant = 'neutral',
  size = 'md',
  busy = false,
  busyLabel = '…',
  block = false,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`rounded disabled:opacity-40 disabled:cursor-not-allowed ${
        VARIANTS[variant]
      } ${SIZES[size]} ${block ? 'w-full' : ''} ${className}`}
    >
      {busy ? busyLabel : children}
    </button>
  );
}
