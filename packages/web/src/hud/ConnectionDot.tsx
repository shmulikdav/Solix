import { useSolixStore } from '../store/index.js';
import { RECONNECT_DELAY_MS } from '../ws/client.js';
import { Tooltip } from './Tooltip.js';

/**
 * Live connection to the Solix server.
 *
 * This was a bordered pill reading CONNECTED / OFFLINE, which looked exactly
 * like the controls beside it and did nothing when clicked. A status readout
 * dressed as a button teaches people to distrust the styling everywhere else,
 * so it is a dot now and the detail moved into a tooltip.
 *
 * The state is carried by fill and motion as well as hue — solid and still
 * when connected, hollow and pulsing when not — so it does not depend on
 * telling green from red.
 *
 * The tooltip also says something the chip had no room for: the socket retries
 * on its own, and until it succeeds the galaxy on screen is stale. Previously
 * the UI went on showing old data with nothing but a red word to explain it.
 */
export function ConnectionDot(): JSX.Element {
  const connected = useSolixStore((s) => s.connected);
  const retrySeconds = (RECONNECT_DELAY_MS / 1000).toFixed(1).replace(/\.0$/, '');

  const label = connected
    ? 'Connected — live updates are flowing.'
    : `Disconnected. Retrying every ${retrySeconds}s — the galaxy shown may be stale.`;

  return (
    <Tooltip content={label}>
      {(tip) => (
        <span
          {...tip}
          role="status"
          aria-label={label}
          tabIndex={0}
          className="flex items-center gap-1.5 rounded p-0.5 outline-none focus-visible:ring-1 focus-visible:ring-solix-accent"
        >
          <span
            aria-hidden="true"
            className={`block w-1.5 h-1.5 rounded-full ${
              connected
                ? 'bg-solix-ok'
                : 'border border-solix-danger solix-pulse'
            }`}
          />
          {/* The word is back. Removing it was an over-correction from "this
              pill looks like a button": a bare dot is unambiguous about
              nothing, and the complaint was that nobody could tell what it
              meant. Dot plus one word is still not button-shaped. */}
          <span
            aria-hidden="true"
            className={`text-[11px] ${
              connected ? 'text-slate-500' : 'text-solix-danger'
            }`}
          >
            {connected ? 'Live' : 'Offline'}
          </span>
        </span>
      )}
    </Tooltip>
  );
}
