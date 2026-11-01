import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { RegistryClient } from './cloud.js';

/**
 * CLAIM-NO-TELEMETRY · Solix makes no request you did not ask for.
 *
 * "100% local", "Zero telemetry" and "Where does my code go? Nowhere" are
 * three of the four things the home page leads with, and they had no test.
 * That is the same shape as the six overclaims this ledger exists for,
 * except with more at stake: the gate failing is a bug, and this failing is
 * a betrayal of the one reason to run a control plane locally at all.
 *
 * It is true today — checked by hand before writing this. The point of
 * pinning it is that it stays true by accident otherwise. One `fetch` to
 * count installs, added in good faith, would contradict the front page and
 * nothing would say so.
 *
 * The honest scope: Solix does reach the network, but only where someone
 * configured a destination — a Slack or Telegram notifier in Connections, a
 * reporting sink, a galaxy manifest URL typed into import. Each of those is
 * a URL the user supplied. What the claim rules out is Solix choosing a
 * destination of its own.
 */
const SRC = [
  resolve(import.meta.dirname ?? __dirname),
  resolve(import.meta.dirname ?? __dirname, '..', '..', 'cli', 'src'),
];

/** Loopback, in the spellings that appear in this codebase. */
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\]|::1)$/;

/**
 * The one hardcoded remote host, and the only file allowed to contain it.
 * Telegram's bot API has a fixed hostname, so the URL is built here while
 * the token that makes it reachable comes from the user's own Connections
 * entry. Slack needs no entry at all: its destination is the webhook URL
 * the user pasted.
 */
const ALLOWED: Record<string, string> = {
  'api.telegram.org': 'state/notifiers.ts',
};

function shippedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.ts$/.test(entry) && !entry.includes('.test.')) out.push(full);
    }
  };
  for (const root of SRC) walk(root);
  return out;
}

describe('CLAIM-NO-TELEMETRY', () => {
  const files = shippedFiles();

  it('finds the source to scan', () => {
    // A scan that silently matches nothing would pass every assertion here.
    expect(files.length).toBeGreaterThan(40);
  });

  it('names no network destination of its own', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(resolve(import.meta.dirname ?? __dirname, '..', '..'), file);
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Comments explain the checks and name example attackers
          // (`https://evil.example`) and placeholders (`https://host/path`).
          // Only code can actually reach a host.
          const t = line.trim();
          if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) {
            return;
          }
          for (const m of line.matchAll(/https?:\/\/([a-zA-Z0-9.-]+)/g)) {
            const host = m[1]!;
            if (LOOPBACK.test(host)) continue;
            // A template like `${baseUrl}/v1/...` has no literal host, so it
            // never reaches here — and the base is user-supplied by
            // definition, which is the whole point.
            const allowedIn = ALLOWED[host];
            if (allowedIn && rel.endsWith(allowedIn)) continue;
            offenders.push(`${rel}:${i + 1}  ${host}`);
          }
        });
    }
    expect(
      offenders,
      'Solix picked a destination the user did not. The front page says ' +
        '"100% local" and "Zero telemetry"; either this is wrong or those ' +
        'are:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });

  it('ships no analytics or crash-reporting dependency', () => {
    const pkg = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname ?? __dirname, '..', '..', 'cli', 'package.json'),
        'utf8',
      ),
    ) as { dependencies?: Record<string, string> };
    const suspicious = Object.keys(pkg.dependencies ?? {}).filter((d) =>
      /analytic|telemetr|posthog|sentry|segment|mixpanel|amplitude|plausible|bugsnag|datadog/i.test(
        d,
      ),
    );
    expect(
      suspicious,
      'a telemetry SDK in the published package would send on its own, ' +
        'whatever the code does',
    ).toEqual([]);
  });

  it('the galaxy registry is inert until someone points it somewhere', () => {
    // There is no hosted Solix. `RegistryClient` is a client for a service
    // that was never built — which is why the brief says Share does not
    // share. It must stay switched off by absence rather than by intent.
    const saved = process.env.SOLIX_REGISTRY_URL;
    delete process.env.SOLIX_REGISTRY_URL;
    try {
      expect(new RegistryClient().isConfigured()).toBe(false);
    } finally {
      if (saved !== undefined) process.env.SOLIX_REGISTRY_URL = saved;
    }
  });

  it('and refuses to publish rather than guessing a host', async () => {
    const client = new RegistryClient('', undefined);
    await expect(
      client.publish('anything', { advisors: [], skills: [] } as never),
    ).rejects.toThrow(/not configured/i);
  });
});
