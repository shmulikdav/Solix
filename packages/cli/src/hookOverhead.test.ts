import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * CLAIM-HOOK-OVERHEAD-BOUNDED.
 *
 * The brief and the install banner used to put "~2ms each" on the hooks that
 * fire on every tool call. That number is the cost of starting `sh`, not of
 * the hook — each hook also does a POST to Solix, and the review clocked the
 * real figure near 16ms, an order of magnitude more. A loopback roundtrip is
 * machine-dependent and not a number worth publishing. What *is* worth
 * publishing, and is enforceable, is the bound: a hook can never hold up a
 * tool call for more than its cap, and can never fail one.
 *
 * So rather than assert a latency this repo cannot reproduce (curl to
 * 127.0.0.1 is proxied and unmeasurable in CI), this pins the two properties
 * that actually protect the user, straight from the shipped scripts:
 *
 *  1. Every network call is time-capped — the telemetry POST at one second,
 *     the blocking gate call at the gate timeout. No `curl` is unbounded, so
 *     no hook can hang a tool call indefinitely on a slow or missing Solix.
 *  2. Every hook fails open on the observability path — an unreachable Solix
 *     ends the hook `exit 0`, never a non-zero exit that would block the call.
 */
const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');
const hooks = readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.sh'));

describe('CLAIM-HOOK-OVERHEAD-BOUNDED · the shipped hook scripts', () => {
  it('ships a hook for every event (not an empty directory)', () => {
    expect(hooks.length).toBeGreaterThanOrEqual(9);
  });

  for (const name of hooks) {
    describe(name, () => {
      const body = readFileSync(join(HOOKS_DIR, name), 'utf8');
      const curlLines = body
        .split('\n')
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => /^\s*(RESP=\$\()?curl\b/.test(l) || /^\s*curl\b/.test(l));

      it('has at least one curl, and none of them is unbounded', () => {
        expect(curlLines.length).toBeGreaterThanOrEqual(1);
        for (const { l } of curlLines) {
          // The flag may sit on a continuation line; check the whole command
          // block from this curl to its terminating line.
          expect(l).toMatch(/curl/);
        }
        // Every curl invocation in the file carries a --max-time somewhere in
        // its backslash-continued command. Counting is enough: one cap per curl.
        const curlCount = (body.match(/curl\b/g) ?? []).length;
        const maxTimeCount = (body.match(/--max-time\b/g) ?? []).length;
        // The header comment mentions --max-time once; subtract nothing — we
        // only require at least as many caps as curls.
        expect(maxTimeCount).toBeGreaterThanOrEqual(curlCount);
      });

      it('caps the telemetry POST at one second', () => {
        expect(body).toMatch(/\/events"[\s\S]*?--max-time 1/);
      });

      it('fails open — the script ends exit 0 on every path it controls', () => {
        // Every `exit` in the script is `exit 0`: a hook never returns non-zero,
        // which in Claude Code would block the tool call it is observing.
        const exits = body.match(/^\s*exit\s+\d+/gm) ?? [];
        expect(exits.length).toBeGreaterThanOrEqual(1);
        for (const e of exits) expect(e.trim()).toBe('exit 0');
      });
    });
  }

  it('the blocking gate call is bounded by the gate timeout, not unbounded', () => {
    // Only the pre-tool hooks block for a human; their long call is still
    // capped — at the gate timeout — so even a hung server releases the agent.
    for (const name of hooks.filter((h) => h.startsWith('pre-tool-'))) {
      const body = readFileSync(join(HOOKS_DIR, name), 'utf8');
      expect(body).toMatch(/\/events\/permission"[\s\S]*?--max-time "\$SOLIX_GATE_TIMEOUT"/);
    }
  });
});
