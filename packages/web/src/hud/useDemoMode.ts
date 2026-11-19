import { useEffect, useState } from 'react';

/**
 * Whether this server is `solix demo`'s sandbox, read once from /api/health.
 * Demo mode cannot change while the page is open.
 *
 * Shared by the DEMO DATA badge and the welcome modal: the modal used to
 * suggest running `solix demo` to someone already inside it (reported by an
 * outside tester on 2026-11-19, on the first screen an evaluator sees).
 */
export function useDemoMode(): boolean {
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

  return demo;
}
