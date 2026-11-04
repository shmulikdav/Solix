import { spawnSync } from 'node:child_process';
import { resolvePort } from '@solix/shared';

/**
 * `solix stop`, and the message a second `solix` prints when the port is taken.
 *
 * Measured on 2026-11-03 while upgrading: after `npm i -g`, the new `solix`
 * said "port 4242 is already in use" and nothing more. The server that kept
 * running was the old version, so the browser kept showing it. The only way
 * out was `kill $(lsof -tiTCP:4242 -sTCP:LISTEN)`, which nobody types from
 * memory. Worse, the new `solix` had already updated the hooks before it
 * found the port busy, so new hooks were talking to an old server, the one
 * holding the security fixes the user had just installed. Now the message
 * names the version and pid that hold the port, and `solix stop` replaces it.
 */
export interface RunningSolix {
  version: string;
  pid?: number;
  headless?: boolean;
}

export interface StopDeps {
  probe(port: number): Promise<RunningSolix | null>;
  pidListeningOn(port: number): number | undefined;
  kill(pid: number): void;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/** What answers /api/health on this port, if it is Solix. */
export async function probeSolix(port: number): Promise<RunningSolix | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { service?: string; version?: string; pid?: number; headless?: boolean };
    if (body.service !== 'solix') return null;
    return { version: body.version ?? 'unknown', pid: typeof body.pid === 'number' ? body.pid : undefined, headless: body.headless };
  } catch {
    return null;
  }
}

/** The pid listening on a port, via lsof — for servers older than 1.20.4, which don't report it. */
export function pidListeningOn(port: number): number | undefined {
  const r = spawnSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const pid = Number((r.stdout ?? '').split('\n')[0]);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

/** The message a second `solix` prints when the port is taken. Pure. */
export function portInUseMessage(port: number, running: RunningSolix | null, ourVersion: string): string {
  if (!running) {
    return (
      `[solix] port ${port} is already in use by something that is not Solix — nothing was started.\n` +
      `        Run \`solix start --port ${port + 1}\` to use another port.`
    );
  }
  const who = `Solix ${running.version} is already running on port ${port}${running.pid ? ` (pid ${running.pid})` : ''}`;
  if (running.version !== ourVersion) {
    return (
      `[solix] ${who}, and this is ${ourVersion} — nothing was started.\n` +
      `        The browser shows the running version, not this one. Replace it:\n` +
      `          solix stop${port === 4242 ? '' : ` --port ${port}`} && solix${port === 4242 ? '' : ` --port ${port}`}`
    );
  }
  return (
    `[solix] ${who} — nothing was started.\n` +
    `        Open http://127.0.0.1:${port}, or restart it: solix stop${port === 4242 ? '' : ` --port ${port}`} && solix${port === 4242 ? '' : ` --port ${port}`}`
  );
}

export const defaultStopDeps: StopDeps = {
  probe: probeSolix,
  pidListeningOn,
  kill: (pid) => process.kill(pid, 'SIGTERM'),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (l) => console.log(l),
};

/**
 * Stop the Solix server on a port. Only ever signals a process that answered
 * /api/health as Solix: anything else on the port is left alone. SIGTERM, so
 * Solix's own shutdown runs — held decisions are refused and audited.
 * Exit code: 0 stopped (or nothing to stop), 1 refused or did not stop.
 */
export async function stop(opts: { port?: number } = {}, deps: StopDeps = defaultStopDeps): Promise<number> {
  const port = opts.port ?? resolvePort();
  const running = await deps.probe(port);
  if (!running) {
    const other = deps.pidListeningOn(port);
    if (other) {
      deps.log(`[solix] port ${port} is held by pid ${other}, which is not Solix — not touching it.`);
      return 1;
    }
    deps.log(`[solix] no Solix is running on port ${port}.`);
    return 0;
  }
  const pid = running.pid ?? deps.pidListeningOn(port);
  if (!pid) {
    deps.log(
      `[solix] Solix ${running.version} is running on port ${port}, but its pid can't be found.\n` +
        `        Stop it in the terminal it runs in (Ctrl+C), or: kill $(lsof -tiTCP:${port} -sTCP:LISTEN)`,
    );
    return 1;
  }
  if (pid === process.pid) {
    deps.log('[solix] refusing to stop this process');
    return 1;
  }
  deps.kill(pid);
  for (let waited = 0; waited < 10_000; waited += 250) {
    await deps.sleep(250);
    if (!(await deps.probe(port))) {
      deps.log(`[solix] stopped Solix ${running.version} (pid ${pid}) on port ${port}.`);
      return 0;
    }
  }
  deps.log(`[solix] sent SIGTERM to pid ${pid}, but Solix ${running.version} is still answering on port ${port}.`);
  return 1;
}
