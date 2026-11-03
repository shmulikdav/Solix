import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { ApprovalRuleInput } from '@solix/shared';
import { openDbReadonly, type DB } from '@solix/server/db';
import { defaultRuleInputs, parseRuleInput } from '@solix/server/rules';
import { buildReport, reportToMarkdown } from '@solix/server/report';
import { buildSolixHooks } from './install.js';

/**
 * `solix gate` — run an agent under a rules policy with nobody at the gate.
 *
 *   solix gate --rules policy.json [--out solix-gate/] [--allow-denials] -- claude -p "…"
 *
 * This is how a team's CI and unattended agents run under the same policy its
 * people do. The attended gate holds an uncovered call for a person; in CI
 * there is no person, so a held call would just stall for the timeout and
 * then be denied. Here a call a rule allows proceeds, a call nothing covers is
 * refused at once (fail closed), the containment denylist runs first as
 * always, and the record of what happened — every audit row, plus a signed
 * report — is written out as a CI artifact.
 *
 * Exit code: the agent's own if it failed; otherwise 3 if any call was refused
 * (a step that refused something and still went green would be lying), unless
 * `--allow-denials`; 2 for a bad policy or a gate that would not start.
 * (`CLAIM-HEADLESS-FAILS-CLOSED`)
 */

export interface GateOptions {
  /** A JSON file of rule inputs, or `defaults` for Solix's opt-in set. */
  rules: string;
  out?: string;
  allowDenials?: boolean;
  /** Use this SOLIX_HOME for the gate's server instead of a fresh temp one. */
  home?: string;
  /** The agent command, everything after `--`. */
  command: string[];
}

export interface GateServer {
  port: number;
  stop(): Promise<void>;
  /** The run's records, read after the server has stopped. */
  openDb(): DB;
}

export interface GateDeps {
  startServer(home: string): Promise<GateServer>;
  runAgent(command: string[], env: NodeJS.ProcessEnv): Promise<number>;
  now(): number;
  log(line: string): void;
}

export const EXIT_REFUSED = 3;
export const EXIT_GATE_ERROR = 2;

/**
 * Load and validate the policy before anything starts.
 *
 *   defaults                                  Solix's opt-in set
 *   [ rule, … ]                               exactly these rules
 *   { "rules": [ rule, … ] }                  the same
 *   { "extends": "defaults", "rules": [ … ] } the defaults, plus these
 *
 * `extends` exists because a policy written from scratch has to list every
 * read-only command an agent might pipe through. Measured on 2026-11-03: three
 * gate runs in a row were refused for a missing `head`, then a `2>&1`, before
 * the one command the policy was about ever ran. Deny rules win over allow
 * rules wherever they come from, so a policy can extend the defaults and still
 * refuse something they allow. (`CLAIM-POLICY-EXTENDS-DEFAULTS`)
 */
export function loadPolicy(spec: string): { ok: true; rules: ApprovalRuleInput[] } | { ok: false; error: string } {
  if (spec === 'defaults') return { ok: true, rules: defaultRuleInputs() };
  const path = resolve(spec);
  if (!existsSync(path)) return { ok: false, error: `no rules file at ${path}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return { ok: false, error: `${path} is not valid JSON: ${(err as Error).message}` };
  }
  const shape = `${path} must be a JSON array of rules, or { "extends": "defaults", "rules": [...] }`;
  let base: ApprovalRuleInput[] = [];
  let list: unknown;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object') {
    const obj = raw as { extends?: unknown; rules?: unknown };
    for (const key of Object.keys(obj)) {
      if (key !== 'extends' && key !== 'rules') return { ok: false, error: `${path}: unknown key "${key}" — ${shape}` };
    }
    if (obj.extends !== undefined) {
      if (obj.extends !== 'defaults') {
        return { ok: false, error: `${path}: "extends" can only be "defaults", got ${JSON.stringify(obj.extends)}` };
      }
      base = defaultRuleInputs();
    }
    list = obj.rules ?? (obj.extends !== undefined ? [] : undefined);
  }
  if (!Array.isArray(list)) return { ok: false, error: shape };
  const rules: ApprovalRuleInput[] = [...base];
  for (const [i, item] of list.entries()) {
    // A gate run has no project id up front, so every rule is global to it.
    const parsed = parseRuleInput({ ...(item as object), scope: 'global', projectId: undefined, createdBy: 'gate' });
    if (!parsed.ok) return { ok: false, error: `rule ${i}: ${parsed.error}` };
    rules.push(parsed.input);
  }
  return { ok: true, rules };
}

interface AuditRow {
  ts: number;
  kind: string;
  session_id: string | null;
  summary: string;
  payload_json: string | null;
}

function detailOf(row: AuditRow): string {
  try {
    const p = JSON.parse(row.payload_json ?? '{}') as {
      command?: string;
      args?: { command?: string; file_path?: string };
      tool?: string;
    };
    return p.command ?? p.args?.command ?? p.args?.file_path ?? p.tool ?? row.summary;
  } catch {
    return row.summary;
  }
}

export async function gate(opts: GateOptions, deps: GateDeps = defaultDeps()): Promise<number> {
  const { log } = deps;
  if (opts.command.length === 0) {
    log('[solix gate] nothing to run — put the agent command after `--`');
    return EXIT_GATE_ERROR;
  }
  const policy = loadPolicy(opts.rules);
  if (!policy.ok) {
    log(`[solix gate] policy rejected, nothing was run: ${policy.error}`);
    return EXIT_GATE_ERROR;
  }

  const home = opts.home ? resolve(opts.home) : mkdtempSync(join(tmpdir(), 'solix-gate-'));
  mkdirSync(home, { recursive: true });
  let server: GateServer;
  try {
    server = await deps.startServer(home);
  } catch (err) {
    log(`[solix gate] the gate did not start, nothing was run: ${(err as Error).message}`);
    return EXIT_GATE_ERROR;
  }
  const base = `http://127.0.0.1:${server.port}`;

  try {
    for (const rule of policy.rules) {
      const res = await fetch(`${base}/api/rules`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rule),
      });
      if (!res.ok) {
        log(`[solix gate] could not load a rule (${res.status}); nothing was run`);
        await server.stop();
        return EXIT_GATE_ERROR;
      }
    }
  } catch (err) {
    log(`[solix gate] could not reach the gate to load rules: ${(err as Error).message}`);
    await server.stop();
    return EXIT_GATE_ERROR;
  }

  // What the gate's hooks need to reach this gate and fail closed.
  const gateEnv: Record<string, string> = {
    SOLIX_HOME: home,
    SOLIX_HOST: '127.0.0.1',
    SOLIX_PORT: String(server.port),
    SOLIX_GATE_ENABLED: '1',
    SOLIX_GATE_POLICY: 'deny', // the hook refuses if the gate is unreachable
    SOLIX_GATE_TIMEOUT: '30', // nothing is held, so a long wait means a fault
  };
  const settingsPath = join(home, 'gate-settings.json');
  const command = [...opts.command];
  const isClaude = basename(command[0]!) === 'claude';
  let env: NodeJS.ProcessEnv;
  if (isClaude) {
    // The gate's settings ride on its own hook commands, not on the agent.
    // Measured on a real machine (2026-11-03): with them exported into
    // claude's environment, the Solix hooks installed globally in
    // ~/.claude/settings.json read the same values, also reported to the
    // gate, and every call was decided and recorded twice ("2 allowed · 2
    // refused" for one of each). With the values scoped to the gate's hooks
    // and scrubbed from the agent, a global hook sees an ordinary session —
    // the gate's hooks are the only gate. (`CLAIM-GATE-ONE-HOOK-SET`)
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: buildSolixHooks(join(home, 'hooks'), gateEnv) }, null, 2),
    );
    command.splice(1, 0, '--settings', settingsPath);
    env = { ...process.env, SOLIX_GATE_SETTINGS: settingsPath };
    for (const k of Object.keys(gateEnv)) delete env[k];
  } else {
    // Another runtime has no `--settings`; whatever hooks it is configured
    // with can only find the gate through the environment.
    writeFileSync(settingsPath, JSON.stringify({ hooks: buildSolixHooks(join(home, 'hooks'), gateEnv) }, null, 2));
    env = { ...process.env, ...gateEnv, SOLIX_GATE_SETTINGS: settingsPath };
  }

  log(`[solix gate] ${policy.rules.length} rule(s) loaded; uncovered calls will be refused`);
  const startedAt = deps.now();
  const agentCode = await deps.runAgent(command, env);
  const endedAt = deps.now();
  await server.stop();

  // The artifact: every audit row of the run, plus a signed report.
  const outDir = resolve(opts.out ?? 'solix-gate');
  mkdirSync(outDir, { recursive: true });
  const db = server.openDb();
  let rows: AuditRow[];
  try {
    rows = db
      .prepare('SELECT ts, kind, session_id, summary, payload_json FROM audit_events WHERE ts >= ? ORDER BY ts ASC')
      .all(startedAt) as AuditRow[];
    const report = buildReport(db, { since: startedAt, until: Math.max(endedAt, startedAt + 1) });
    writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(join(outDir, 'report.md'), reportToMarkdown(report));
  } finally {
    db.close();
  }
  writeFileSync(join(outDir, 'audit.json'), JSON.stringify(rows.map((r) => ({ ...r, payload: safeJson(r.payload_json) })), null, 2));

  const allowed = rows.filter((r) => r.kind === 'permission_auto_approved').length;
  const refused = rows.filter((r) => r.kind === 'permission_auto_denied');
  const blocked = rows.filter((r) => r.kind === 'command_blocked');
  log(
    `[solix gate] agent exited ${agentCode} · ${allowed} allowed by rule · ` +
      `${refused.length} refused · ${blocked.length} blocked by the denylist`,
  );
  for (const r of [...refused, ...blocked]) log(`  ✗ ${detailOf(r)}`);
  log(`[solix gate] audit + signed report in ${outDir}`);

  if (agentCode !== 0) return agentCode;
  if (refused.length + blocked.length > 0 && !opts.allowDenials) {
    log('[solix gate] failing: calls were refused (pass --allow-denials to accept that)');
    return EXIT_REFUSED;
  }
  return 0;
}

function safeJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

/** The real thing: a child `solix start --headless` on an isolated home. */
export function defaultDeps(): GateDeps {
  return {
    now: () => Date.now(),
    log: (line) => console.log(line),
    async startServer(home) {
      const port = await freePort();
      const childEnv: NodeJS.ProcessEnv = { ...process.env, SOLIX_HOME: home };
      delete childEnv.SOLIX_DB_PATH; // the gate's records live in its own home
      const child = spawn(
        process.execPath,
        [process.argv[1]!, 'start', '--headless', '--no-wire', '--port', String(port)],
        { env: childEnv, stdio: ['ignore', 'ignore', 'inherit'] },
      );
      const exited = new Promise<void>((r) => child.once('exit', () => r()));
      const deadline = Date.now() + 20_000;
      for (;;) {
        if (child.exitCode !== null) throw new Error('the gate server exited during startup');
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/health`);
          const body = (await res.json()) as { headless?: boolean };
          if (res.ok && body.headless) break;
        } catch {
          /* not listening yet */
        }
        if (Date.now() > deadline) {
          child.kill('SIGKILL');
          throw new Error('the gate server did not come up within 20s');
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      return {
        port,
        async stop() {
          if (child.exitCode !== null) return;
          child.kill('SIGTERM');
          const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
          await exited;
          clearTimeout(timer);
        },
        openDb: () => openDbReadonly(join(home, 'solix.db')),
      };
    },
    runAgent(command, env) {
      return new Promise((done) => {
        const child = spawn(command[0]!, command.slice(1), { env, stdio: 'inherit' });
        child.on('error', (err) => {
          console.error(`[solix gate] could not start ${command[0]}: ${err.message}`);
          done(127);
        });
        child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
      });
    },
  };
}
