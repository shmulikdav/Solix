import { useEffect, useState } from 'react';

/**
 * Says, on screen, that none of this is real.
 *
 * `solix demo` seeds ~30 sessions across 8 projects and keeps a ticker
 * running — and it was pixel-identical to a real galaxy. There was no
 * badge, banner, watermark or flag the client could read; the only signals
 * were terminal lines printed behind the browser window the demo had just
 * opened.
 *
 * Three things made that worse than untidy. The seeder routes synthetic
 * tokens through the *same* cost function as real usage, on purpose, so
 * Mission Control shows a credible dollar figure in a product whose pitch
 * is cost governance. The ticker raises a `rm -rf node_modules` permission
 * prompt every 75 seconds against a directory that does not exist. And
 * following the README in order leaves two tabs open — real and empty on
 * 4242, fake and full on 4243 — with nothing to tell them apart.
 *
 * Demo mode cannot change while the page is open, so this asks once.
 */
export function DemoBadge(): JSX.Element | null {
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/health', { cache: 'no-store' });
        if (!res.ok) return;
        const data = (await res.json()) as { demo?: boolean };
        if (!cancelled && data.demo === true) setDemo(true);
      } catch {
        /* a real server that cannot be reached is not a demo */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!demo) return null;

  return (
    <span
      role="status"
      className="select-none rounded border border-solix-warn bg-solix-warn/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-solix-warn"
      title="solix demo — every agent, cost and permission request on this page is invented. Ctrl+C in the terminal to stop it."
    >
      demo data
    </span>
  );
}
