import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSolixServer, type SolixServerHandle } from './create.js';
import { resetDbForTests } from './db.js';

/**
 * The websocket half of `CLAIM-HOST-IS-OURS`. The HTTP routes refuse a
 * foreign `Host`; the upgrade has to as well, or a rebound page could open
 * `ws://attacker.example:4242/ws` — which a browser treats as same-origin —
 * and receive every event Solix broadcasts, decisions included.
 *
 * Browsers always send `Origin` on a websocket handshake, and the Origin
 * gate already refuses a foreign one. This pins the Host gate on its own,
 * with no Origin at all, which is the shape a non-browser client sends and
 * the shape a browser never can — so the two gates are independently held.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Attempt an upgrade with exactly these headers; report what came back. */
function upgrade(port: number, headers: Record<string, string>): Promise<'upgraded' | number | 'error'> {
  return new Promise((resolve) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port,
      path: '/ws',
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve('upgraded');
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve('error'));
    req.end();
  });
}

describe('CLAIM-HOST-IS-OURS — the websocket answers only to its own names', () => {
  let handle: SolixServerHandle | null = null;
  let port = 0;
  let prevHome: string | undefined;
  let prevAgentView: string | undefined;

  beforeEach(async () => {
    prevHome = process.env.SOLIX_HOME;
    prevAgentView = process.env.SOLIX_DISABLE_AGENTVIEW;
    process.env.SOLIX_HOME = mkdtempSync(join(tmpdir(), 'solix-ws-host-'));
    process.env.SOLIX_DISABLE_AGENTVIEW = '1';
    resetDbForTests();
    port = await freePort();
    handle = await createSolixServer({ port });
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
    if (prevHome === undefined) delete process.env.SOLIX_HOME;
    else process.env.SOLIX_HOME = prevHome;
    if (prevAgentView === undefined) delete process.env.SOLIX_DISABLE_AGENTVIEW;
    else process.env.SOLIX_DISABLE_AGENTVIEW = prevAgentView;
  });

  it('refuses the upgrade under a foreign Host, even with no Origin', async () => {
    expect(await upgrade(port, { Host: 'attacker.example' })).toBe(403);
    expect(await upgrade(port, { Host: 'attacker.example:4242' })).toBe(403);
  });

  it('accepts it under a loopback Host', async () => {
    expect(await upgrade(port, { Host: `127.0.0.1:${port}` })).toBe('upgraded');
    expect(await upgrade(port, { Host: `localhost:${port}` })).toBe('upgraded');
  });

  it('still refuses a foreign Origin on a good Host', async () => {
    expect(await upgrade(port, { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example' })).toBe(403);
  });
});
