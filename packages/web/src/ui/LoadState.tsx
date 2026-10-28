import type { ReactNode } from 'react';
import { Button } from './Button.js';

/**
 * What a fetched list is currently doing.
 *
 * Three states, because the Fleet tabs only ever had two. Their refresh
 * looked like this:
 *
 *     try {
 *       const r = await fetch('/api/connections');
 *       setConns((await r.json()) as Connection[]);
 *     } catch {
 *       // server not reachable
 *     }
 *
 * — so an unreachable server left the list `[]` and the panel rendered
 * "No connections yet. Add one above." **An error displayed as an empty
 * state**, in Connections, Teams and Crew alike. Only Crew hedged, and only
 * in its wording.
 *
 * The distinction is not cosmetic: "you have none" invites you to make one,
 * and "I could not ask" tells you to look at the server. Guessing wrong
 * sends people to add a connection they already have.
 */
export type LoadState = 'loading' | 'ready' | 'error';

/**
 * What to render in place of a list that has no rows.
 *
 * Only call this when the list IS empty — a stale list is better than a
 * spinner over the top of it.
 */
export function ListPlaceholder({
  state,
  label,
  empty,
  onRetry,
}: {
  state: LoadState;
  /** What could not be loaded, for the error line: "Could not load {label}." */
  label: string;
  /** Copy for the genuinely-empty case. Each list says its own thing. */
  empty: ReactNode;
  onRetry: () => void;
}): JSX.Element {
  if (state === 'loading') {
    return (
      <div className="text-[11px] text-slate-500 italic" role="status">
        Loading {label}…
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="space-y-1.5" role="status">
        <div className="text-[11px] text-solix-warn">
          Could not load {label} — the Solix server did not answer. This is not
          the same as having none.
        </div>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </div>
    );
  }

  return <div className="text-[11px] text-slate-500">{empty}</div>;
}
