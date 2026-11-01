import { createServer as createUnixServer } from 'node:net';
import { mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import { resolvePort } from '@solix/shared';

const PORT = String(resolvePort());
const BASE = `http://127.0.0.1:${PORT}`;

interface RegisterPayload {
  wrapperId: string;
  socketPath: string;
  cwd: string;
}

async function registerWithServer(payload: RegisterPayload): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/api/wrappers/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function unregisterFromServer(wrapperId: string): Promise<void> {
  try {
    await fetch(
      `${BASE}/api/wrappers/${encodeURIComponent(wrapperId)}/unregister`,
      { method: 'POST', signal: AbortSignal.timeout(800) },
    );
  } catch {
    /* server gone — registration was ephemeral anyway */
  }
}

/**
 * `solix run [args]` — wrap a claude session under a PTY so Solix can
 * forward prompts from the UI into claude's stdin. The user's terminal
 * still sees the full claude TUI; this is a transparent passthrough
 * that adds a server-driven side channel.
 *
 * Lifecycle:
 *   1. Generate a wrapperId; mkdir ~/.solix/wrappers/.
 *   2. POST /api/wrappers/register with id + socket path + cwd.
 *   3. Spawn claude under a PTY, forward stdin/stdout/resize.
 *   4. Listen on the socket — incoming `{type:'send_prompt', text}`
 *      frames get written to claude's PTY stdin.
 *   5. On claude exit: tear down the socket, unregister, exit.
 *
 * If node-pty fails to load (rare prebuild edge cases), we fall back
 * to a clear error rather than degrading to a non-wrapped spawn.
 */
export async function runWrapped(args: string[]): Promise<void> {
  // Lazy-load node-pty so users without bidirectional support can still
  // run other solix subcommands even on platforms where node-pty's
  // native module didn't compile.
  let pty: typeof import('node-pty');
  try {
    pty = await import('node-pty');
  } catch (err) {
    console.error(
      '[solix run] node-pty failed to load. ' +
        'Bidirectional chat needs a working PTY; on most platforms a clean ' +
        '`pnpm install` (or `npm rebuild`) fixes it.',
    );
    console.error(`[solix run] underlying error: ${(err as Error).message}`);
    process.exit(1);
  }

  const wrapperId = nanoid(10);
  const sockDir = join(homedir(), '.solix', 'wrappers');
  mkdirSync(sockDir, { recursive: true });
  const socketPath = join(sockDir, `${wrapperId}.sock`);
  const cwd = process.cwd();

  // Best-effort registration. The wrapper still runs claude even if
  // the server is offline — the only thing that breaks is the UI's
  // ability to send prompts, which is the whole point but not worth
  // blocking the user's session over.
  const registered = await registerWithServer({ wrapperId, socketPath, cwd });

  // Spawn claude under a PTY with the user's current terminal size
  // and env. SOLIX_WRAPPER_ID gives downstream tools (and us, on
  // restart-recovery) a way to identify wrapped sessions.
  const cols = process.stdout.columns ?? 80;
  const rows = process.stdout.rows ?? 24;
  const term = pty.spawn('claude', args, {
    name: process.env.TERM ?? 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, SOLIX_WRAPPER_ID: wrapperId },
  });

  // ── terminal stdin → PTY ────────────────────────────────────────────
  const wasRaw = Boolean(process.stdin.isTTY);
  if (wasRaw) process.stdin.setRawMode?.(true);
  process.stdin.resume();
  const onStdin = (chunk: Buffer): void => {
    term.write(chunk.toString('utf8'));
  };
  process.stdin.on('data', onStdin);

  // ── PTY → terminal stdout ───────────────────────────────────────────
  term.onData((d) => {
    process.stdout.write(d);
  });

  // ── resize forwarding ──────────────────────────────────────────────
  const onResize = (): void => {
    term.resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24);
  };
  process.stdout.on('resize', onResize);

  // ── server-side prompt injection ───────────────────────────────────
  // Newline-delimited JSON frames. Each `send_prompt` frame becomes a
  // PTY write of `text + \r` so claude treats it as Enter-terminated.
  const sockServer = createUnixServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (chunk: string) => {
      buf += chunk;
      let i = buf.indexOf('\n');
      while (i >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) {
          try {
            const msg = JSON.parse(line) as { type: string; text?: string };
            if (msg.type === 'send_prompt' && typeof msg.text === 'string') {
              term.write(msg.text + '\r');
            }
          } catch {
            // Malformed frame from the server — ignore. We don't want
            // a single bad payload to kill the wrapper.
          }
        }
        i = buf.indexOf('\n');
      }
    });
    conn.on('error', () => {
      /* socket peer crashed; nothing for us to do */
    });
  });
  sockServer.on('error', (err) => {
    console.error(`[solix run] socket error: ${err.message}`);
  });
  sockServer.listen(socketPath);

  if (registered) {
    process.stderr.write(
      `[solix run] wrapped — UI prompts to this session will land here. ` +
        `Don't type a prompt while the UI is sending one.\n`,
    );
  } else {
    process.stderr.write(
      `[solix run] note: Solix server not reachable at ${BASE}; claude will ` +
        `run normally, but the UI composer won't be active.\n`,
    );
  }

  // ── cleanup ────────────────────────────────────────────────────────
  let cleaned = false;
  const cleanup = async (exitCode = 0): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      sockServer.close();
    } catch {
      /* ignore */
    }
    try {
      unlinkSync(socketPath);
    } catch {
      /* ignore */
    }
    if (registered) await unregisterFromServer(wrapperId);
    process.stdin.removeListener('data', onStdin);
    process.stdout.removeListener('resize', onResize);
    if (wasRaw) {
      try {
        process.stdin.setRawMode?.(false);
      } catch {
        /* ignore */
      }
    }
    process.exit(exitCode);
  };

  term.onExit(({ exitCode }) => {
    void cleanup(exitCode ?? 0);
  });

  // Forward Ctrl+C and other terminating signals to the child.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => {
      try {
        term.kill();
      } catch {
        /* already dead */
      }
    });
  }
}
