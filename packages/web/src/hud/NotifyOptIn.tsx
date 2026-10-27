import { useState } from 'react';
import { notificationState, requestPermission } from '../notifications.js';

/**
 * The one control that can turn on the product's central signal.
 *
 * Permission used to be requested from inside `notify()`, and every caller
 * passes `whenHidden: true` — so the only moment it ever asked was while the
 * tab was hidden, which is exactly the moment browsers refuse to prompt.
 * There was no gesture-driven path anywhere, so "an agent is blocked and
 * waiting for you" never reached anyone who had tabbed away.
 *
 * This lives in the top bar rather than behind a panel because it has to be
 * seen *before* someone tabs away, and it disappears for good once answered
 * — an opt-in that nags after you have decided is its own problem.
 */
export function NotifyOptIn(): JSX.Element | null {
  const [state, setState] = useState(notificationState);

  // Granted needs no control, and a browser without the API cannot be
  // talked into one.
  if (state === 'granted' || state === 'unsupported') return null;

  if (state === 'denied') {
    return (
      <span
        className="hidden select-none text-[10px] text-slate-500 sm:inline"
        title="Your browser is blocking notifications for this page. Allow them in the address-bar site settings, then reload."
      >
        notifications blocked
      </span>
    );
  }

  return (
    <button
      onClick={() => {
        void requestPermission().then(setState);
      }}
      className="rounded border border-solix-border px-1.5 py-0.5 text-[10px] text-slate-400 hover:border-solix-accent hover:text-solix-accent"
      title="Get a desktop notification when an agent is blocked waiting on you, so you can leave this tab"
    >
      ◔ notify me
    </button>
  );
}
