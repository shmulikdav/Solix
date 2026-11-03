/**
 * Local-only origin trust check.
 *
 * Solix binds to loopback, so the *only* legitimate browser origin is a
 * loopback address (on any port — `solix start --port`, the Vite dev proxy
 * on 4243, the demo's fallback port, etc.). A malicious page the user
 * merely visits is served from a real internet origin (e.g.
 * `https://evil.example`), so it fails this check — which is what stops it
 * opening the WebSocket or POSTing to the process-spawning `/api/*` routes.
 *
 * A **missing** Origin header means a non-browser caller — the shell hooks,
 * `curl`, `solix demo`'s Node `fetch` — which cannot mount a cross-site
 * request forgery, so it is allowed. Browsers always send `Origin` on
 * cross-origin requests and on every WebSocket handshake, so this closes the
 * CSRF / WS-hijack vector *without* the same-origin UI needing to hold the
 * install token.
 */
export function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true; // non-browser caller (hooks/curl/node) — not CSRF-able
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false; // malformed Origin → reject
  }
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

/**
 * SSRF guard for server-side fetches (currently `POST /api/galaxy/import`,
 * which makes the *server* fetch a caller-supplied URL). Requires http(s)
 * and rejects loopback / private / link-local hosts so a manifest URL can't
 * be turned into a probe of internal network services. Not proof against DNS
 * rebinding, but closes the obvious internal-address vector; the CSRF
 * middleware already blocks the browser-driven path.
 */
export function isSafeFetchUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.localhost')) return false;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 127 || a === 10) return false; // this-host / loopback / private
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a === 192 && b === 168) return false; // private
  }
  if (h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) {
    return false; // IPv6 unique-local / link-local
  }
  return true;
}

/**
 * Is this `Host` header one this instance may be addressed by?
 *
 * Solix binds to loopback and used to trust any request that arrived there —
 * including one a browser sent to `attacker.example` after a DNS-rebinding
 * page pointed that name at 127.0.0.1. Such a request is *same-origin* from
 * the browser's point of view: no `Origin` header, no CORS, and the response
 * is readable. Measured on 1.18.3: `GET /api/plans`, `/api/missions` and
 * `/api/system/governance` answered 200 with data under a foreign `Host`.
 * Mutations were already refused by the Origin gate; reads were not.
 *
 * So the name in `Host` must be a loopback name, a `*.localhost` name, or one
 * the operator listed in `SOLIX_ALLOWED_HOSTS` (comma-separated, for a LAN or
 * tailnet address). The port is ignored. A *missing* `Host` is allowed: every
 * browser sends one, so its absence means a non-browser caller.
 */
export function isAllowedHost(
  host: string | undefined | null,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (host === undefined || host === null) return true;
  let name = host.trim().toLowerCase();
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end === -1) return false;
    name = name.slice(1, end);
  } else {
    const colon = name.indexOf(':');
    if (colon !== -1) name = name.slice(0, colon);
  }
  if (!name) return false;
  if (name === '127.0.0.1' || name === 'localhost' || name === '::1') return true;
  if (name.endsWith('.localhost')) return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return true;
  const extra = (env.SOLIX_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return extra.includes(name);
}
