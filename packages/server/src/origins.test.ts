import { describe, expect, it } from 'vitest';
import { isAllowedOrigin, isSafeFetchUrl } from './origins.js';

/**
 * CLAIM-WS-ORIGIN · only a loopback origin can drive the control plane.
 *
 * `isAllowedOrigin` guards the WebSocket upgrade (`ws.ts`) and every
 * mutating HTTP method (`http.ts`). The WS surface accepts
 * `launch_session`, `send_prompt` and `invoke`, and browsers do not apply
 * CORS to a WebSocket handshake — so without this check any page someone
 * merely visits could open `ws://127.0.0.1:4242/ws` and drive their agents.
 *
 * It had no tests at all. Probing it by hand found no defect, which is the
 * reason to write these now rather than later: the function is correct and
 * one careless simplification — `includes('localhost')`, a regex, a
 * `startsWith` — turns it into a hole that nothing would report. Each case
 * below is an attack the current implementation already defeats.
 */
describe('CLAIM-WS-ORIGIN', () => {
  it('allows the loopback origins the UI is actually served from', () => {
    for (const origin of [
      'http://127.0.0.1:4242',
      'http://localhost:4242',
      'http://localhost:4243', // the Vite dev proxy
      'http://127.0.0.1:4455', // --port
      'http://[::1]:4242',
      'https://localhost:4242',
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(true);
    }
  });

  it('refuses an ordinary internet origin — the whole point', () => {
    for (const origin of [
      'https://evil.example',
      'http://evil.example',
      'https://www.google.com',
      'null', // a sandboxed iframe sends the literal string
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
  });

  it('is not fooled by a hostname that merely contains a loopback name', () => {
    // The substring attacks. Each of these is what a `includes()` or a
    // sloppy `startsWith()` would wave through.
    for (const origin of [
      'http://localhost.evil.example',
      'http://127.0.0.1.evil.example',
      'http://evil-localhost.example',
      'http://localhost.example.com',
      'http://notlocalhost',
      'https://127.0.0.1.nip.io',
      'http://[::1].evil.example',
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
  });

  it('is not fooled by credentials or a path pointing at loopback', () => {
    for (const origin of [
      'http://localhost@evil.example',
      'http://evil.example/127.0.0.1',
      'http://evil.example#localhost',
      'http://evil.example?x=http://localhost',
    ]) {
      expect(isAllowedOrigin(origin), origin).toBe(false);
    }
  });

  it('defeats DNS rebinding, because it reads the origin and not the address', () => {
    // A name resolving to 127.0.0.1 does not change what the browser sends
    // as Origin, which is why this check is the right one.
    expect(isAllowedOrigin('http://rebind.attacker.example')).toBe(false);
  });

  it('rejects a malformed Origin rather than throwing', () => {
    for (const origin of ['', 'not a url', '://', 'http://', '%%%']) {
      expect(() => isAllowedOrigin(origin)).not.toThrow();
    }
    expect(isAllowedOrigin('not a url')).toBe(false);
  });

  it('allows a caller that sends no Origin at all, deliberately', () => {
    // The shell hooks, curl and `solix demo`'s Node fetch send no Origin and
    // cannot mount a cross-site request, so they pass. Browsers always send
    // one on a WS handshake and on any non-safe method, which is what makes
    // this safe rather than a bypass. The `/events` surface is additionally
    // token-guarded for exactly the local-process case this lets through.
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin(null)).toBe(true);
  });
});

/**
 * CLAIM-IMPORT-NO-SSRF · a galaxy manifest URL cannot probe the local network.
 *
 * `POST /api/galaxy/import` makes the *server* fetch a caller-supplied URL,
 * so it is the one place where a URL from outside turns into an outbound
 * request from inside. Untested alongside `isAllowedOrigin`.
 */
describe('CLAIM-IMPORT-NO-SSRF', () => {
  it('allows an ordinary public https URL', () => {
    expect(isSafeFetchUrl('https://example.com/galaxy.json')).toBe(true);
  });

  it('refuses loopback, private and link-local targets', () => {
    for (const url of [
      'http://127.0.0.1:4242/api/health',
      'http://localhost/secret',
      'http://[::1]/',
      'http://10.0.0.5/',
      'http://172.16.0.1/',
      'http://172.31.255.254/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/', // cloud metadata
      'http://0.0.0.0/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
    ]) {
      expect(isSafeFetchUrl(url), url).toBe(false);
    }
  });

  it('refuses a non-http scheme, so file:// cannot be read back', () => {
    for (const url of [
      'file:///etc/passwd',
      'ftp://example.com/x',
      'data:text/plain,hi',
      'gopher://example.com/',
    ]) {
      expect(isSafeFetchUrl(url), url).toBe(false);
    }
  });

  it('refuses garbage without throwing', () => {
    expect(() => isSafeFetchUrl('not a url')).not.toThrow();
    expect(isSafeFetchUrl('not a url')).toBe(false);
  });

  it('is honest about what it does not cover', () => {
    // Documented in origins.ts: a public hostname that resolves to a private
    // address still passes, because this inspects the URL and not DNS. The
    // claim is "closes the obvious internal-address vector", not "proof
    // against rebinding" — so this pins the honest scope rather than
    // pretending otherwise.
    expect(isSafeFetchUrl('http://rebind.attacker.example/')).toBe(true);
  });
});
