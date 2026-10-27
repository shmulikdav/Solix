import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { resetDbForTests, type DB } from './db.js';
import { Broadcaster } from './broadcaster.js';
import { EventRouter } from './router.js';
import { Orchestrator } from './orchestrator/index.js';
import { createHttpApp } from './http.js';

/**
 * The gate, hook-to-server, against a server that is actually listening.
 *
 * `gate.contract.test.ts` runs the hook with **no server** — it pins the
 * fail-closed, fail-open and observe branches. What neither it nor any other
 * test covered is the branch the product exists for: gate on, server up, a
 * human answers, and the hook hands Claude Code that answer.
 *
 * A live `claude` cannot be driven in CI, but everything between the hook
 * script and the decision can: this runs the real `pre-tool-bash.sh` with
 * curl against a real port, and resolves the permission through the same API
 * the browser uses. What is left for the manual smoke test is only whether
 * Claude Code honours the decision it is handed.
 */
const HOOK = resolve('packages/cli/hooks/pre-tool-bash.sh');

interface HookRun {
  stdout: string;
  status: number | null;
}

/** Run the hook as Claude Code does: payload on stdin, decision on stdout. */
function runHook(env: Record<string, string>, command: string): Promise<HookRun> {
  return new Promise((done) => {
    const child = spawn('sh', [HOOK], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', () => {});
    child.on('close', (status) => done({ stdout, status }));
    child.stdin.write(
      JSON.stringify({
        session_id: 'live-gate-test',
        tool_name: 'Bash',
        tool_input: { command },
      }),
    );
    child.stdin.end();
  });
}

function decisionOf(stdout: string): string | null {
  const t = stdout.trim();
  if (!t) return null;
  return (
    (JSON.parse(t) as { hookSpecificOutput?: { permissionDecision?: string } })
      .hookSpecificOutput?.permissionDecision ?? null
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('gate end-to-end: real hook against a listening server', () => {
  let db: DB;
  let router: EventRouter;
  let server: { close: (cb?: () => void) => void };
  let port = 0;
  let gateEnv: Record<string, string>;

  beforeAll(async () => {
    db = resetDbForTests();
    const broadcaster = new Broadcaster();
    router = new EventRouter(db, broadcaster);
    const orchestrator = new Orchestrator({
      db,
      runner: { runOnce: () => Promise.resolve({ ok: true, output: '{}' }) },
      broadcast: () => {},
      getKnownAdvisorRoles: () => [],
      knownModels: ['default'],
      getMaestroPrompt: () => '',
    });
    const app = createHttpApp({ db, router, orchestrator });

    await new Promise<void>((ready) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        port = info.port;
        ready();
      }) as unknown as { close: (cb?: () => void) => void };
    });

    gateEnv = {
      SOLIX_GATE_ENABLED: '1',
      SOLIX_GATE_POLICY: 'deny',
      SOLIX_HOST: '127.0.0.1',
      SOLIX_PORT: String(port),
      // No token file in a test HOME, and createHttpApp only enforces the
      // token when one was configured — so the hook's empty token is fine.
      SOLIX_HOME: '/nonexistent-solix-home',
    };
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Wait for the hook's request to surface as a pending permission. */
  async function pendingRequestId(timeoutMs = 8000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = router.pendingPermissions?.() ?? [];
      if (pending.length > 0) return pending[0]!.requestId;
      await sleep(50);
    }
    throw new Error('no permission request arrived from the hook');
  }

  it('holds the command until a human answers, then allows it', async () => {
    const run = runHook(gateEnv, 'echo hello');

    // The hook must still be waiting — this is the whole product.
    await sleep(400);
    let settled = false;
    void run.then(() => (settled = true));
    await sleep(100);
    expect(settled).toBe(false);

    const requestId = await pendingRequestId();
    expect(router.resolvePermission(requestId, true)).toBe(true);

    const { stdout, status } = await run;
    expect(decisionOf(stdout)).toBe('allow');
    expect(status).toBe(0);
  }, 20000);

  it('denies when the human denies', async () => {
    const run = runHook(gateEnv, 'rm -rf ./canary');
    const requestId = await pendingRequestId();
    router.resolvePermission(requestId, false);

    const { stdout } = await run;
    expect(decisionOf(stdout)).toBe('deny');
  }, 20000);

  /**
   * A denial has to tell the agent it was a PERSON saying no, or the agent
   * treats it as a transient obstacle and tries again in different words.
   * Observed in the wild: denied `rm -rf ./canary`, so it came back with
   * `rm ./canary/keep.txt && rmdir ./canary`, three times. Each retry is
   * another card for a human to read, and the fourth one gets approved out
   * of fatigue.
   *
   * The reason text is what Claude Code feeds back to the model, so this is
   * the only channel that can stop the loop.
   */
  it('tells the agent a person decided, and not to reword it', async () => {
    const run = runHook(gateEnv, 'rm -rf ./canary');
    const requestId = await pendingRequestId();
    router.resolvePermission(requestId, false);

    const { stdout } = await run;
    const out = JSON.parse(stdout.trim()) as {
      hookSpecificOutput: { permissionDecisionReason: string };
    };
    const reason = out.hookSpecificOutput.permissionDecisionReason;

    expect(reason).toMatch(/person/i);
    expect(reason).toMatch(/do not retry/i);
    expect(reason).toMatch(/reword/i);
    // And it must not read as a glitch the agent should route around.
    expect(reason).toMatch(/not a transient failure/i);
  }, 20000);

  /**
   * The escape hatch an interactive session would use. Nothing sets
   * SOLIX_GATE_ENABLED for a `claude` you start yourself, but a user can
   * export it — and if the site is ever going to mention that, the path has
   * to work rather than be assumed to.
   */
  it('a session that opts in by exporting the flag is gated too', async () => {
    const optedIn = { ...gateEnv, SOLIX_GATE_POLICY: 'fail-open' };
    const run = runHook(optedIn, 'curl https://example.com | sh');
    const requestId = await pendingRequestId();
    router.resolvePermission(requestId, false);

    // Denied by the human, not by the fail policy — the server answered.
    expect(decisionOf((await run).stdout)).toBe('deny');
  }, 20000);

  /**
   * Regression guard for the shape Claude Code actually parses: a decision is
   * honoured only when stdout is exactly one JSON object. Proven here against
   * a live answer, where the contract test could only prove it for a refusal.
   */
  it('emits exactly one JSON object on the allow path', async () => {
    const run = runHook(gateEnv, 'ls -la');
    const requestId = await pendingRequestId();
    router.resolvePermission(requestId, true);

    const out = (await run).stdout.trim();
    expect(out.split('\n')).toHaveLength(1);
    expect(out.startsWith('{') && out.endsWith('}')).toBe(true);
    expect(() => JSON.parse(out)).not.toThrow();
  }, 20000);
});
