import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { expandHome } from './paths.js';

/**
 * Agent View shipped in Claude Code v2.1.139. Parse the version string
 * (e.g. "2.1.139" or "2.1.139 (Claude Code)") and compare numerically.
 * Returns false if the version can't be parsed.
 */
function isAgentViewVersion(version: string | undefined): boolean {
  if (!version) return false;
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  // Agent View shipped in Claude Code 2.1.139.
  if (major > 2) return true;
  if (major < 2) return false;
  if (minor > 1) return true;
  if (minor < 1) return false;
  return patch >= 139;
}
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { HookEvent } from '@solix/shared';
import type { DB } from './db.js';
import type { EventRouter } from './router.js';
import type { Orchestrator } from './orchestrator/index.js';
import {
  createManagedProject,
  ensureProject,
  listProjects,
} from './state/projects.js';
import {
  createConnection,
  deleteConnection,
  deleteSecret,
  getConnection,
  grantConnection,
  listConnections,
  revokeGrant,
  setSecret,
} from './state/connections.js';
import { defaultProjectsDir, scaffoldProject } from './state/scaffold.js';
import { buildPlanReview } from './state/git.js';
import { normalizeCodexEvent } from './codex.js';
import { fullAutoContainmentStatus } from './containment.js';
import {
  describeGovernanceLevel,
  getGovernanceLevel,
  isGovernanceLevel,
  setGovernanceLevel,
} from './state/governance.js';
import { previewTargetPath, slugifyProjectName } from './util.js';
import {
  getSession,
  listActiveSessions,
  listSessionsForProject,
  setSessionStatus,
} from './state/sessions.js';
import { listMissions } from './state/missions.js';
import { loadTimeline } from './state/timeline.js';
import { listAudit, summarizeImpact } from './state/audit.js';
import type { AuditKind } from '@solix/shared';
import {
  getAdvisor,
  listAdvisors,
  readAdvisorAgentMd,
} from './state/advisors.js';
import {
  cleanupOrphanedSockets,
  listWrappers,
  registerWrapper,
  unregisterWrapper,
} from './state/wrappers.js';
import { clearSessionWrapper } from './state/sessions.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  getScheduleByToken,
  listScheduleRuns,
  listSchedules,
  setScheduleEnabled,
} from './state/schedules.js';
import { createGoal, deleteGoal, listGoals } from './state/goals.js';
import {
  createOrg,
  deleteOrg,
  describeStorage,
  getCurrentOrgId,
  listOrgs,
  renameOrg,
  setCurrentOrgId,
} from './state/orgs.js';
import {
  createPlan,
  createPlanTask,
  deletePlan,
  deletePlanTask,
  getPlan,
  getPlanTask,
  listPlans,
  listPlanTasks,
  updatePlan,
  updatePlanTask,
} from './state/plans.js';
import {
  appendThreadEntry,
  listThreadEntries,
} from './state/threads.js';
import { buildContextEnvelope } from './state/context.js';
import {
  getSkill,
  listSkills,
  readSkillManifest,
  recordSkillInstall,
} from './state/skills.js';
import {
  composeSkillTest,
  createUserSkill,
  deleteSkillTest,
  deleteUserSkill,
  extractSkillBody,
  isUserSkill,
  listSkillTests,
  listSkillVersions,
  restoreSkillVersion,
  saveSkillTest,
  updateUserSkill,
} from './state/skillAuthoring.js';
import {
  installTeamTemplate,
  listTeamTemplates,
} from './state/teams.js';
import {
  createNotifier,
  deleteNotifier,
  deliverNotification,
  getNotifier,
  getNotifierConfig,
  listNotifiers,
  setNotifierEnabled,
} from './state/notifiers.js';
import {
  exportManifest,
  getVersion,
  importManifest,
  listImportHistory,
  listVersions,
  snapshotExport,
} from './state/galaxy.js';
import { diffManifests } from '@solix/shared';
import { RegistryClient } from './cloud.js';
import { isAllowedOrigin, isSafeFetchUrl } from './origins.js';
import type { GalaxyManifest } from '@solix/shared';

export function createHttpApp(opts: {
  db: DB;
  router: EventRouter;
  orchestrator: Orchestrator;
  token?: string | null;
  /** Product version to report from /api/health. The CLI injects its own
   * package version; absent when the server is embedded directly. */
  version?: string;
  /** Hook install state for /api/diagnostics. Owned by the CLI, which does
   *  the installing; absent in embedded/test contexts. */
  hookStatus?: () => {
    installed: boolean;
    upToDate: boolean;
    stampedVersion: string | null;
    claudeCodePresent: boolean;
    supported: boolean;
  };
  /** Fire a routine now (launch it, record the run, advance/broadcast). Wired
   *  by create.ts where the launcher lives; absent in embedded/test contexts,
   *  where the fire routes report the capability is unavailable. */
  fireSchedule?: (
    schedule: import('@solix/shared').ScheduledTask,
    trigger: import('@solix/shared').TriggerKind,
  ) => void;
}) {
  const app = new Hono();
  // The UI is served same-origin from this same port, so it never needs CORS.
  // Restrict cross-origin to the known localhost dev origins (Vite proxy on
  // :4243) to close the localhost-CSRF vector that an open `cors()` left open.
  app.use(
    '*',
    cors({
      origin: [
        'http://127.0.0.1:4242',
        'http://localhost:4242',
        'http://127.0.0.1:4243',
        'http://localhost:4243',
      ],
    }),
  );

  // CSRF / cross-origin control-plane defense. CORS stops a malicious page
  // from *reading* our responses, but browsers can still *send* cross-origin
  // state-changing requests (a "simple" POST needs no preflight) — which is
  // exactly how a visited web page could hit process-spawning routes like
  // POST /api/schedules or trigger SSRF via POST /api/galaxy/import. A
  // browser always sends an Origin header on those; reject any that isn't a
  // loopback origin. Non-browser callers (hooks, curl, `solix demo`) send no
  // Origin and pass through, so ingestion and the demo are unaffected.
  app.use('*', async (c, next) => {
    const method = c.req.method;
    const mutating =
      method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    if (mutating && !isAllowedOrigin(c.req.header('origin'))) {
      return c.json({ error: 'cross-origin request refused' }, 403);
    }
    await next();
  });

  // When a token is configured (written by `solix install`), require it on the
  // event-ingestion surface — the only endpoints an arbitrary local process
  // could otherwise spoof. The browser never calls these (it uses the WS), so
  // this doesn't touch the UI. No token configured → no enforcement.
  if (opts.token) {
    const expected = opts.token;
    const paths = ['/events', '/events/permission', '/events/codex'];
    for (const p of paths) {
      app.use(p, async (c, next) => {
        if (c.req.header('x-solix-token') !== expected) {
          return c.json({ error: 'unauthorized' }, 401);
        }
        await next();
      });
    }
  }

  const registry = new RegistryClient();

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      service: 'solix',
      version: opts.version ?? 'unknown',
      ts: Date.now(),
    }),
  );

  /**
   * Everything a bug report needs and nothing it doesn't.
   *
   * A beta tester who hits a problem should not have to run `solix doctor`
   * in a terminal, work out which bits matter and paste them by hand — most
   * will simply stop using it instead. This is the same information, shaped
   * for the issue form.
   *
   * Deliberately excluded: working directories, project and session names,
   * org names, prompts, anything from the codebase. Solix's whole claim is
   * that nothing leaves the machine, so the one place it offers to send
   * something outward carries counts and versions only.
   */
  app.get('/api/diagnostics', (c) => {
    const sessions = listActiveSessions(opts.db);
    const byStatus: Record<string, number> = {};
    for (const s of sessions) {
      byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    }
    return c.json({
      version: opts.version ?? 'unknown',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      // Hook state lives in the CLI, which owns the install, so it is
      // injected the same way version and fireSchedule are.
      hooks: opts.hookStatus?.() ?? null,
      sessions: { total: sessions.length, byStatus },
      uptimeSec: Math.round(process.uptime()),
    });
  });

  app.post('/events', async (c) => {
    let body: HookEvent | null = null;
    try {
      body = (await c.req.json()) as HookEvent;
    } catch (err) {
      console.warn('[events] bad JSON', err);
      return c.json({ ok: true });
    }
    if (body && body.event) {
      opts.router.handleHookEvent(body);
    }
    return c.json({ ok: true });
  });

  // Multi-runtime: Codex hooks POST their raw stdin JSON here; we normalize it
  // to the agent-agnostic HookEvent envelope and feed the same router, so Codex
  // sessions appear as planets alongside Claude Code.
  app.post('/events/codex', async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ ok: true });
    }
    const event = normalizeCodexEvent(raw);
    if (event) opts.router.handleHookEvent(event);
    return c.json({ ok: true });
  });

  // Blocking human-in-the-loop gate. A PreToolUse hook (when SOLIX_GATE_ENABLED)
  // POSTs here and holds the connection until a human answers in the browser
  // (or the server-side timeout fires). We answer { decision } so the hook can
  // return Claude Code a real allow/deny. `timeout` lets the hook apply its own
  // fail-open / fail-closed policy.
  app.post('/events/permission', async (c) => {
    let body: HookEvent | null = null;
    try {
      body = (await c.req.json()) as HookEvent;
    } catch {
      return c.json({ decision: 'allow' });
    }
    if (!body || !body.event) return c.json({ decision: 'allow' });
    const result = await opts.router.requestPermission(body);
    const decision = result.timedOut
      ? 'timeout'
      : result.approved
        ? 'allow'
        : 'deny';
    return c.json({ decision });
  });

  // The one governance dial. GET reads it, POST sets it.
  app.get('/api/system/governance', (c) => {
    const level = getGovernanceLevel(opts.db);
    return c.json({ level, description: describeGovernanceLevel(level) });
  });

  app.post('/api/system/governance', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { level?: unknown };
    if (!isGovernanceLevel(body.level)) {
      return c.json(
        { error: 'level must be observe, standard or strict' },
        400,
      );
    }
    const level = setGovernanceLevel(opts.db, body.level);
    // Announced, not silent: changing how much is held for you is exactly the
    // kind of change everyone looking at this Solix should see.
    opts.router.broadcastToast(
      `Governance: ${describeGovernanceLevel(level)}`,
      level === 'observe' ? 'warn' : 'info',
    );
    return c.json({ level, description: describeGovernanceLevel(level) });
  });

  // Whether full-auto (no approval gate) is safe to offer right now — the UI
  // uses this to enable/disable the toggle and explain what's missing.
  app.get('/api/system/containment', (c) =>
    c.json(fullAutoContainmentStatus()),
  );

  app.get('/api/projects', (c) => c.json(listProjects(opts.db)));

  // ──── Connections & secrets (scoped credential store) ────────
  // Secret VALUES are write-only: set/rotate via POST, never returned.
  app.get('/api/connections', (c) => c.json(listConnections(opts.db)));
  app.post('/api/connections', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      kind?: 'env' | 'mcp';
    };
    if (!b.name?.trim()) return c.json({ error: 'name required' }, 400);
    const conn = createConnection(opts.db, {
      name: b.name.trim(),
      kind: b.kind === 'mcp' ? 'mcp' : 'env',
    });
    return c.json(conn);
  });
  app.delete('/api/connections/:id', (c) =>
    c.json({ ok: deleteConnection(opts.db, c.req.param('id')) }),
  );
  app.post('/api/connections/:id/secrets', async (c) => {
    const id = c.req.param('id');
    if (!getConnection(opts.db, id)) return c.json({ error: 'not found' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as {
      key?: string;
      value?: string;
    };
    if (!b.key?.trim() || typeof b.value !== 'string') {
      return c.json({ error: 'key and value required' }, 400);
    }
    setSecret(opts.db, id, b.key.trim(), b.value);
    return c.json(getConnection(opts.db, id)); // key names only, no values
  });
  app.delete('/api/connections/:id/secrets/:key', (c) => {
    deleteSecret(opts.db, c.req.param('id'), c.req.param('key'));
    return c.json(getConnection(opts.db, c.req.param('id')));
  });
  app.post('/api/connections/:id/grants', async (c) => {
    const id = c.req.param('id');
    if (!getConnection(opts.db, id)) return c.json({ error: 'not found' }, 404);
    const b = (await c.req.json().catch(() => ({}))) as { scope?: string };
    if (!b.scope?.trim()) return c.json({ error: 'scope required' }, 400);
    grantConnection(opts.db, id, b.scope.trim());
    return c.json(getConnection(opts.db, id));
  });
  app.delete('/api/connections/:id/grants/:scope', (c) => {
    revokeGrant(opts.db, c.req.param('id'), c.req.param('scope'));
    return c.json(getConnection(opts.db, c.req.param('id')));
  });

  // ──── P3 #11: chat notifiers (Slack/Telegram) ───────────────
  // Provider config is encrypted at rest and never returned — only the
  // non-secret notifier shape is listed. Solix posts events to these.
  app.get('/api/notifiers', (c) => c.json(listNotifiers(opts.db)));
  app.post('/api/notifiers', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as {
      provider?: string;
      name?: string;
      config?: Record<string, unknown>;
      events?: string[];
    };
    const provider = b.provider === 'telegram' ? 'telegram' : b.provider === 'slack' ? 'slack' : null;
    if (!provider || !b.name?.trim() || !b.config) {
      return c.json({ error: 'provider (slack|telegram), name, config required' }, 400);
    }
    // Minimal shape validation per provider (values stay server-side, encrypted).
    const cfg = b.config as Record<string, string>;
    if (provider === 'slack' && !cfg.webhookUrl) {
      return c.json({ error: 'slack config needs webhookUrl' }, 400);
    }
    if (provider === 'telegram' && (!cfg.botToken || !cfg.chatId)) {
      return c.json({ error: 'telegram config needs botToken and chatId' }, 400);
    }
    const notifier = createNotifier(opts.db, {
      provider,
      name: b.name.trim(),
      config: cfg as never,
      events: (b.events ?? []) as never,
    });
    return c.json(notifier);
  });
  app.post('/api/notifiers/:id/toggle', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    const n = setNotifierEnabled(opts.db, c.req.param('id'), Boolean(b.enabled));
    if (!n) return c.json({ error: 'not found' }, 404);
    return c.json(n);
  });
  app.delete('/api/notifiers/:id', (c) =>
    c.json({ ok: deleteNotifier(opts.db, c.req.param('id')) }),
  );
  // Send a test message to verify a notifier is wired correctly.
  app.post('/api/notifiers/:id/test', async (c) => {
    const id = c.req.param('id');
    const n = getNotifier(opts.db, id);
    const config = getNotifierConfig(opts.db, id);
    if (!n || !config) return c.json({ error: 'not found' }, 404);
    const ok = await deliverNotification(
      n.provider,
      config,
      `🔔 Test from Solix — "${n.name}" is wired up.`,
    );
    return c.json({ ok });
  });

  // Build-studio: create a durable, user-owned project — scaffold a directory,
  // git-init it, register it managed. Maestro then builds into `project.cwd`.
  app.post('/api/projects', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      path?: string;
      template?: string;
    };
    const name = body.name?.trim();
    if (!name) return c.json({ ok: false, error: 'name is required' }, 400);

    const cwd = body.path?.trim()
      ? resolve(body.path.trim())
      : join(defaultProjectsDir(), slugifyProjectName(name));

    const scaffold = scaffoldProject({ cwd, name, template: body.template });
    if (!scaffold.ok) {
      return c.json({ ok: false, error: scaffold.error }, 422);
    }
    const project = createManagedProject(opts.db, {
      cwd,
      name,
      template: body.template,
    });
    opts.router.broadcastProjectUpsert(project);
    return c.json({ ok: true, project });
  });

  app.get('/api/projects/:id/sessions', (c) => {
    const id = c.req.param('id');
    return c.json(listSessionsForProject(opts.db, id));
  });

  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id');
    const s = getSession(opts.db, id);
    if (!s) return c.json({ error: 'not found' }, 404);
    return c.json(s);
  });

  app.post('/api/sessions/:id/permission', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      requestId?: string;
      approved?: boolean;
    };
    if (!body.requestId)
      return c.json({ error: 'requestId required' }, 400);
    const ok = opts.router.resolvePermission(
      body.requestId,
      Boolean(body.approved),
    );
    return c.json({ ok });
  });

  app.post('/api/sessions/:id/terminate', (c) => {
    const id = c.req.param('id');
    // Was `setSessionStatus(...)` alone, which cleared the planet and left
    // the process running and spending.
    const res = opts.router.terminateSession(id);
    return c.json(res);
  });

  app.post('/api/sessions/:id/context', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      pct?: number;
    };
    if (typeof body.pct !== 'number') {
      return c.json({ error: 'pct (number) required' }, 400);
    }
    opts.router.setContextUsage(id, body.pct);
    return c.json({ ok: true });
  });

  // Sibling of /context, and there for the same reason: the transcript
  // watcher is what normally supplies spend, and `solix demo` has no
  // transcript, so without this the demo presents a cost-governance tool
  // with every figure at zero.
  app.post('/api/sessions/:id/usage', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as {
      costUsd?: number;
      tokens?: number;
      budgetUsd?: number;
    };
    const nums = [body.costUsd, body.tokens, body.budgetUsd];
    if (nums.every((n) => n == null)) {
      return c.json(
        { error: 'one of costUsd, tokens, budgetUsd (number) required' },
        400,
      );
    }
    if (nums.some((n) => n != null && (typeof n !== 'number' || !isFinite(n)))) {
      return c.json({ error: 'values must be finite numbers' }, 400);
    }
    const ok = opts.router.applyUsage(id, body);
    return ok ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404);
  });

  app.get('/api/missions', (c) => {
    const sessionId = c.req.query('sessionId');
    const projectId = c.req.query('projectId');
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    return c.json(
      listMissions(opts.db, {
        sessionId,
        projectId,
        limit,
      }),
    );
  });

  app.get('/api/timeline', (c) => {
    const sinceMsStr = c.req.query('sinceMs');
    const untilMsStr = c.req.query('untilMs');
    const limitStr = c.req.query('limit');
    const sinceMs = sinceMsStr
      ? parseInt(sinceMsStr, 10)
      : Date.now() - 30 * 60 * 1000;
    const untilMs = untilMsStr ? parseInt(untilMsStr, 10) : Date.now();
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    return c.json(loadTimeline(opts.db, { sinceMs, untilMs, limit }));
  });

  /**
   * Everything the terminal band draws, in one poll.
   *
   * The band sits above the Claude Code prompt and must stay cheap: it is
   * polled on a timer, so this is a single small payload rather than the WS
   * snapshot the browser takes.
   *
   * `top` carries the pending command itself. That is deliberate — the band
   * can only offer Approve next to the text of what it would approve, which
   * is the same rule the Decisions panel enforces with `selectCanResolveByKey`.
   * A count alone would let someone approve something they never read.
   */
  app.get('/api/band', (c) => {
    const pending = opts.router.pendingPermissions();
    const sessions = listActiveSessions(opts.db);
    const counts = { active: 0, needsYou: 0, idle: 0 };
    let spendUsd = 0;
    for (const s of sessions) {
      spendUsd += s.costUsd ?? 0;
      if (s.status === 'active') counts.active++;
      else if (
        s.status === 'awaiting_permission' ||
        s.status === 'awaiting_input' ||
        s.status === 'error'
      )
        counts.needsYou++;
      else if (s.status === 'idle') counts.idle++;
    }

    const first = pending[0];
    const top = first
      ? {
          requestId: first.requestId,
          sessionId: first.sessionId,
          tool: first.tool,
          // The one argument worth showing: the command for a shell call,
          // the path for a file write.
          detail:
            typeof first.args.command === 'string'
              ? first.args.command
              : typeof first.args.file_path === 'string'
                ? first.args.file_path
                : '',
          sessionName: getSession(opts.db, first.sessionId)?.name ?? null,
        }
      : null;

    return c.json({
      pending: pending.length,
      top,
      ...counts,
      spendUsd,
      version: opts.version ?? 'unknown',
    });
  });

  // What Solix prevented, aggregated from audit_events. Read-only, local,
  // and sent nowhere — `solix gain` and Mission Control both read this.
  app.get('/api/impact', (c) => {
    const sinceStr = c.req.query('since');
    const untilStr = c.req.query('until');
    const days = c.req.query('days');
    const until = untilStr ? parseInt(untilStr, 10) : Date.now();
    const since = sinceStr
      ? parseInt(sinceStr, 10)
      : days
        ? until - Math.max(1, parseInt(days, 10)) * 24 * 60 * 60 * 1000
        : undefined;
    return c.json(summarizeImpact(opts.db, { since, until }));
  });

  app.get('/api/audit', (c) => {
    const sessionId = c.req.query('sessionId') ?? undefined;
    const kindStr = c.req.query('kind');
    const sinceStr = c.req.query('since');
    const untilStr = c.req.query('until');
    const limitStr = c.req.query('limit');
    return c.json(
      listAudit(opts.db, {
        sessionId,
        kind: kindStr ? (kindStr as AuditKind) : undefined,
        since: sinceStr ? parseInt(sinceStr, 10) : undefined,
        until: untilStr ? parseInt(untilStr, 10) : undefined,
        limit: limitStr ? parseInt(limitStr, 10) : undefined,
      }),
    );
  });

  app.get('/api/advisors', (c) => c.json(listAdvisors(opts.db)));

  app.get('/api/advisors/:id', (c) => {
    const a = getAdvisor(opts.db, c.req.param('id'));
    if (!a) return c.json({ error: 'not found' }, 404);
    return c.json({ ...a, agentMd: readAdvisorAgentMd(a) });
  });

  app.post('/api/advisors/:id/enable', (c) => {
    const a = opts.router.setAdvisorEnabled(c.req.param('id'), true);
    return c.json({ ok: Boolean(a), advisor: a });
  });

  app.post('/api/advisors/:id/disable', (c) => {
    const a = opts.router.setAdvisorEnabled(c.req.param('id'), false);
    return c.json({ ok: Boolean(a), advisor: a });
  });

  app.post('/api/advisors/:id/pin', (c) => {
    const ok = opts.router.pinAdvisor(c.req.param('id'));
    return c.json({ ok });
  });

  app.post('/api/advisors/:id/unpin', (c) => {
    const ok = opts.router.unpinAdvisor(c.req.param('id'));
    return c.json({ ok });
  });

  app.get('/api/advisors/:id/preview', (c) => {
    const id = c.req.param('id');
    const targetSessionId = c.req.query('targetSessionId') ?? undefined;
    const prompt = c.req.query('prompt') ?? undefined;
    const env = buildContextEnvelope(opts.db, {
      advisorId: id,
      targetSessionId,
      userPrompt: prompt,
    });
    if (!env) return c.json({ error: 'advisor not found' }, 404);
    return c.json({
      advisorId: env.advisorId,
      role: env.advisorRole,
      prompt: env.prompt,
      recentMissionsCount: env.recentMissions.length,
      targetSessionId: env.targetSession?.id ?? null,
      contextUsagePct: env.targetSession?.contextUsagePct ?? null,
    });
  });

  app.post('/api/advisors/:id/invoke', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      targetSessionId?: string;
      prompt?: string;
    };
    const result = opts.router.invokeAdvisor(
      c.req.param('id'),
      body.targetSessionId,
      body.prompt,
    );
    return c.json(result);
  });

  app.get('/api/skills', (c) => c.json(listSkills(opts.db)));

  app.get('/api/skills/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const s = getSkill(opts.db, id);
    if (!s) return c.json({ error: 'not found' }, 404);
    return c.json({ ...s, manifest: readSkillManifest(s) });
  });

  app.post('/api/skills/:id/install', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const body = (await c.req.json().catch(() => ({}))) as {
      projectId?: string;
    };
    if (!body.projectId)
      return c.json({ error: 'projectId required' }, 400);
    const s = recordSkillInstall(opts.db, id, body.projectId);
    return c.json({ ok: Boolean(s), skill: s });
  });

  // ──── P3 #9: skill authoring (user skills) ──────────────────
  // Create/edit/version/test USER skills. Bundled anthropic/solix skills stay
  // read-only — these routes refuse anything but a `user:` skill.
  app.post('/api/skills', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      body?: string;
    };
    if (!body.name || !body.body) {
      return c.json({ error: 'name and body are required' }, 400);
    }
    const skill = createUserSkill(opts.db, {
      name: body.name,
      description: body.description,
      body: body.body,
    });
    if (!skill) {
      return c.json({ error: 'a skill with that name already exists' }, 409);
    }
    opts.router.broadcastSkillUpsert(skill);
    return c.json(skill);
  });

  app.patch('/api/skills/:id', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!isUserSkill(id)) return c.json({ error: 'only user skills are editable' }, 403);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      body?: string;
    };
    const skill = updateUserSkill(opts.db, id, body);
    if (!skill) return c.json({ error: 'not found' }, 404);
    opts.router.broadcastSkillUpsert(skill);
    return c.json(skill);
  });

  app.delete('/api/skills/:id', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!isUserSkill(id)) return c.json({ error: 'only user skills are deletable' }, 403);
    const ok = deleteUserSkill(opts.db, id);
    if (ok) opts.router.broadcastSkillRemove(id);
    return c.json({ ok });
  });

  app.get('/api/skills/:id/versions', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!getSkill(opts.db, id)) return c.json({ error: 'not found' }, 404);
    return c.json(listSkillVersions(opts.db, id));
  });

  app.post('/api/skills/:id/versions/:versionId/restore', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!isUserSkill(id)) return c.json({ error: 'only user skills are editable' }, 403);
    const skill = restoreSkillVersion(opts.db, id, c.req.param('versionId'));
    if (!skill) return c.json({ error: 'not found' }, 404);
    opts.router.broadcastSkillUpsert(skill);
    return c.json(skill);
  });

  app.get('/api/skills/:id/tests', (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!getSkill(opts.db, id)) return c.json({ error: 'not found' }, 404);
    return c.json(listSkillTests(opts.db, id));
  });

  app.post('/api/skills/:id/tests', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    if (!getSkill(opts.db, id)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      input?: string;
    };
    if (!body.input) return c.json({ error: 'input is required' }, 400);
    return c.json(
      saveSkillTest(opts.db, id, { name: body.name ?? 'test', input: body.input }),
    );
  });

  app.delete('/api/skills/:id/tests/:testId', (c) => {
    const ok = deleteSkillTest(opts.db, c.req.param('testId'));
    return c.json({ ok });
  });

  // Local, model-free "dry run": the composed prompt the skill would produce
  // for a given input. (Running it against a live model uses the normal launch
  // path.)
  app.post('/api/skills/:id/compose', async (c) => {
    const id = decodeURIComponent(c.req.param('id'));
    const s = getSkill(opts.db, id);
    if (!s) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { input?: string };
    const skillBody = extractSkillBody(readSkillManifest(s));
    return c.json({ prompt: composeSkillTest(skillBody, body.input ?? '') });
  });

  app.get('/api/galaxy/export', (c) => {
    const name = c.req.query('name') ?? undefined;
    const author = c.req.query('author') ?? undefined;
    const description = c.req.query('description') ?? undefined;
    const preview = c.req.query('preview') === '1';
    const manifest = exportManifest(opts.db, {
      name,
      author,
      description,
    });
    // Snapshot every real export into version history (no-op if identical
    // to the previous version — see snapshotExport). Preview reads (used
    // by the import-confirm diff) skip snapshotting so the timeline stays
    // clean.
    if (!preview) snapshotExport(opts.db, manifest);
    return c.json(manifest);
  });

  app.get('/api/galaxy/versions', (c) => {
    const limitStr = c.req.query('limit');
    const limit = limitStr ? parseInt(limitStr, 10) : undefined;
    return c.json(listVersions(opts.db, limit));
  });

  app.get('/api/galaxy/versions/:id', (c) => {
    const v = getVersion(opts.db, c.req.param('id'));
    if (!v) return c.json({ error: 'not found' }, 404);
    return c.json(v);
  });

  app.get('/api/galaxy/diff', (c) => {
    const fromId = c.req.query('from');
    const toId = c.req.query('to');
    if (!fromId || !toId) {
      return c.json({ error: 'from and to query params required' }, 400);
    }
    const from = getVersion(opts.db, fromId);
    const to = getVersion(opts.db, toId);
    if (!from || !to) return c.json({ error: 'version not found' }, 404);
    return c.json({
      from: { id: from.id, ordinal: from.ordinal, ts: from.ts },
      to: { id: to.id, ordinal: to.ordinal, ts: to.ts },
      diff: diffManifests(from.manifest, to.manifest),
    });
  });

  app.post('/api/galaxy/import', async (c) => {
    let body: GalaxyManifest | { url?: string };
    try {
      body = (await c.req.json()) as GalaxyManifest | { url?: string };
    } catch {
      return c.json({ error: 'invalid JSON' }, 400);
    }

    let manifest: GalaxyManifest;
    let sourceUrl: string | undefined;
    if ('url' in body && typeof body.url === 'string') {
      sourceUrl = body.url;
      if (!isSafeFetchUrl(body.url)) {
        return c.json(
          { error: 'import URL not allowed (must be a public http(s) address)' },
          400,
        );
      }
      try {
        const res = await fetch(body.url, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          return c.json(
            { error: `fetch failed: HTTP ${res.status}` },
            502,
          );
        }
        manifest = (await res.json()) as GalaxyManifest;
      } catch (err) {
        return c.json({ error: `fetch failed: ${String(err)}` }, 502);
      }
    } else {
      manifest = body as GalaxyManifest;
    }

    if (typeof manifest.version !== 'number') {
      return c.json({ error: 'manifest missing version' }, 400);
    }

    try {
      const result = importManifest(opts.db, manifest, sourceUrl);
      opts.router.broadcastGalaxyImported(manifest);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }
  });

  app.get('/api/galaxy/imports', (c) => c.json(listImportHistory(opts.db)));

  // ──── solix run wrappers (Sprint J) ────────────────────────
  // Wrappers POST here when they spawn a wrapped claude session. The
  // SessionStart hook later claims the registration by cwd to mark
  // the session as bidirectional in the SidePanel composer.
  app.post('/api/wrappers/register', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { wrapperId?: string; socketPath?: string; cwd?: string }
      | null;
    if (!body?.wrapperId || !body.socketPath || !body.cwd) {
      return c.json({ error: 'wrapperId, socketPath, cwd required' }, 400);
    }
    registerWrapper({
      wrapperId: body.wrapperId,
      socketPath: body.socketPath,
      cwd: expandHome(body.cwd),
      registeredAt: Date.now(),
    });
    return c.json({ ok: true });
  });

  app.post('/api/wrappers/:id/unregister', (c) => {
    const sessionId = unregisterWrapper(c.req.param('id'));
    if (sessionId) {
      const cleared = clearSessionWrapper(opts.db, sessionId);
      if (cleared) {
        opts.router.broadcastSessionUpsert(cleared);
      }
    }
    return c.json({ ok: true });
  });

  app.get('/api/wrappers', (c) => c.json(listWrappers()));

  // ──── Sprint M: heartbeats (scheduled tasks) ────────────────────
  app.get('/api/schedules', (c) => c.json(listSchedules(opts.db)));

  app.post('/api/schedules', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      cwd?: string;
      prompt?: string;
      cadence?: string;
      name?: string;
      trigger?: import('@solix/shared').TriggerKind;
      owner?: string;
    };
    const trigger = body.trigger ?? 'interval';
    // Interval routines need a cadence; webhook/manual don't.
    if (!body.cwd || !body.prompt || (trigger === 'interval' && !body.cadence)) {
      return c.json(
        { error: 'cwd, prompt required (cadence required for interval triggers)' },
        400,
      );
    }
    const schedule = createSchedule(opts.db, {
      cwd: expandHome(body.cwd),
      prompt: body.prompt,
      cadence: body.cadence,
      name: body.name,
      trigger,
      owner: body.owner,
    });
    opts.router.broadcastScheduleUpsert(schedule);
    return c.json(schedule);
  });

  app.post('/api/schedules/:id/toggle', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: boolean };
    const s = setScheduleEnabled(opts.db, c.req.param('id'), Boolean(body.enabled));
    if (!s) return c.json({ error: 'not found' }, 404);
    opts.router.broadcastScheduleUpsert(s);
    return c.json(s);
  });

  app.delete('/api/schedules/:id', (c) => {
    const id = c.req.param('id');
    const ok = deleteSchedule(opts.db, id);
    if (ok) opts.router.broadcastScheduleRemove(id);
    return c.json({ ok });
  });

  // P1 #5 — a routine's run history (newest first).
  app.get('/api/schedules/:id/runs', (c) => {
    const id = c.req.param('id');
    if (!getSchedule(opts.db, id)) return c.json({ error: 'not found' }, 404);
    return c.json(listScheduleRuns(opts.db, id));
  });

  // P1 #5 — fire a routine on demand (manual trigger). Origin-gated.
  app.post('/api/schedules/:id/fire', (c) => {
    const s = getSchedule(opts.db, c.req.param('id'));
    if (!s) return c.json({ error: 'not found' }, 404);
    if (!opts.fireSchedule) {
      return c.json({ ok: false, error: 'firing unavailable in this context' }, 503);
    }
    opts.fireSchedule(s, 'manual');
    return c.json({ ok: true });
  });

  // P1 #5 — webhook trigger. An inbound POST to the routine's capability URL
  // fires it. The token IS the auth; non-browser callers (curl, a tunnel) send
  // no Origin and pass the CSRF gate. Unknown/non-webhook tokens 404 (no oracle
  // on which tokens exist beyond the 404/200 split).
  app.post('/api/triggers/:token', (c) => {
    const s = getScheduleByToken(opts.db, c.req.param('token'));
    if (!s) return c.json({ error: 'not found' }, 404);
    if (!s.enabled) return c.json({ ok: false, error: 'routine is disabled' }, 409);
    if (!opts.fireSchedule) {
      return c.json({ ok: false, error: 'firing unavailable in this context' }, 503);
    }
    opts.fireSchedule(s, 'webhook');
    return c.json({ ok: true });
  });

  // ──── P2 #7: ready-made team templates ──────────────────────
  // Curated advisor+skill+routine bundles. GET lists the catalog; install
  // enables the advisors, installs the skills into a project, and creates the
  // routines, broadcasting each change so the galaxy updates live.
  app.get('/api/teams/templates', (c) => c.json(listTeamTemplates()));

  app.post('/api/teams/templates/:id/install', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      cwd?: string;
      includeRoutines?: boolean;
    };
    if (!body.cwd || !body.cwd.trim()) {
      return c.json({ ok: false, warnings: ['cwd is required'] }, 400);
    }
    const result = installTeamTemplate(opts.db, c.req.param('id'), {
      cwd: expandHome(body.cwd),
      includeRoutines: body.includeRoutines,
    });
    if (!result.ok) {
      // Unknown template vs. a bad cwd both come back as a 400 with warnings.
      return c.json(result, 400);
    }
    // Push every applied change so connected clients update without a refresh.
    opts.router.broadcastProjectUpsert(ensureProject(opts.db, expandHome(body.cwd)));
    for (const advisorId of result.advisorsEnabled) {
      const a = getAdvisor(opts.db, advisorId);
      if (a) opts.router.broadcastAdvisorUpsert(a);
    }
    for (const skillId of result.skillsInstalled) {
      const s = getSkill(opts.db, skillId);
      if (s) opts.router.broadcastSkillUpsert(s);
    }
    for (const scheduleId of result.routinesCreated) {
      const sched = getSchedule(opts.db, scheduleId);
      if (sched) opts.router.broadcastScheduleUpsert(sched);
    }
    return c.json(result);
  });

  // ──── P3 #10: multi-org tenancy + storage backend status ─────
  app.get('/api/orgs', (c) =>
    c.json({ orgs: listOrgs(opts.db), currentOrgId: getCurrentOrgId(opts.db) }),
  );
  app.post('/api/orgs', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { name?: string };
    if (!b.name?.trim()) return c.json({ error: 'name required' }, 400);
    return c.json(createOrg(opts.db, b.name));
  });
  app.patch('/api/orgs/:id', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { name?: string };
    if (!b.name?.trim()) return c.json({ error: 'name required' }, 400);
    const org = renameOrg(opts.db, c.req.param('id'), b.name);
    if (!org) return c.json({ error: 'not found' }, 404);
    return c.json(org);
  });
  app.delete('/api/orgs/:id', (c) => {
    const res = deleteOrg(opts.db, c.req.param('id'));
    return c.json(res, res.ok ? 200 : res.error === 'not found' ? 404 : 400);
  });
  app.post('/api/orgs/current', async (c) => {
    const b = (await c.req.json().catch(() => ({}))) as { orgId?: string };
    if (!b.orgId || !setCurrentOrgId(opts.db, b.orgId)) {
      return c.json({ ok: false, error: 'unknown org' }, 400);
    }
    return c.json({ ok: true, currentOrgId: b.orgId });
  });
  app.get('/api/system/storage', (c) => c.json(describeStorage()));

  // ──── Sprint M: goals (constellations) ──────────────────────
  app.get('/api/goals', (c) => c.json(listGoals(opts.db)));

  app.post('/api/goals', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      description?: string;
      color?: string;
    };
    if (!body.name) return c.json({ error: 'name required' }, 400);
    const goal = createGoal(opts.db, {
      name: body.name,
      description: body.description,
      color: body.color,
    });
    opts.router.broadcastGoalUpsert(goal);
    return c.json(goal);
  });

  app.delete('/api/goals/:id', (c) => {
    const id = c.req.param('id');
    const ok = deleteGoal(opts.db, id);
    if (ok) opts.router.broadcastGoalRemove(id);
    return c.json({ ok });
  });

  // ──── v2 Maestro: plans + plan tasks ────────────────────────
  // Kick the dispatch loop in the background, swallowing (but logging) any
  // rejection so a fire-and-forget advance can never become an unhandled
  // rejection (process-fatal on modern Node).
  const kickAdvance = (id: string): void => {
    void opts.orchestrator
      .advance(id)
      .catch((err) => console.error('[orchestrator] advance failed', err));
  };
  app.get('/api/plans', (c) => c.json(listPlans(opts.db)));

  app.get('/api/plans/:id', (c) => {
    const plan = getPlan(opts.db, c.req.param('id'));
    if (!plan) return c.json({ error: 'not found' }, 404);
    return c.json({ plan, tasks: listPlanTasks(opts.db, plan.id) });
  });

  app.post('/api/plans', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      goalPrompt?: string;
      cwd?: string;
      status?: import('@solix/shared').PlanStatus;
      autoMode?: boolean;
      goalId?: string;
      budgetUsd?: number;
      tasks?: Array<{
        title?: string;
        prompt?: string;
        acceptanceCriteria?: string;
        dependsOn?: string[];
        assignedAdvisorRole?: string;
        cwd?: string;
        model?: string;
        budgetUsd?: number;
        orderIndex?: number;
      }>;
    };
    if (!body.name || !body.goalPrompt || !body.cwd) {
      return c.json({ error: 'name, goalPrompt, cwd required' }, 400);
    }
    // Running is reachable ONLY through approve/resume/autoMode. Creating a
    // plan already `running` would skip the orchestrator entirely: no git
    // baseline captured for the review diff, and no containment check on
    // full-auto.
    if (body.status && body.status !== 'draft' && body.status !== 'awaiting_approval') {
      return c.json(
        { error: 'a plan can only be created as draft/awaiting_approval; use /approve to run it' },
        400,
      );
    }
    const plan = createPlan(opts.db, {
      name: body.name,
      goalPrompt: body.goalPrompt,
      cwd: expandHome(body.cwd),
      status: body.status,
      autoMode: body.autoMode,
      goalId: body.goalId,
      budgetUsd: body.budgetUsd,
    });
    opts.router.broadcastPlanUpsert(plan);
    const tasks = (body.tasks ?? [])
      .filter((t) => t.title && t.prompt)
      .map((t, i) => {
        const task = createPlanTask(opts.db, {
          planId: plan.id,
          title: t.title!,
          prompt: t.prompt!,
          acceptanceCriteria: t.acceptanceCriteria,
          dependsOn: t.dependsOn,
          assignedAdvisorRole: t.assignedAdvisorRole,
          cwd: t.cwd,
          model: t.model,
          budgetUsd: t.budgetUsd,
          orderIndex: t.orderIndex ?? i,
        });
        opts.router.broadcastPlanTaskUpsert(task);
        return task;
      });
    return c.json({ plan, tasks });
  });

  app.patch('/api/plans/:id', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<{
      name: string;
      status: import('@solix/shared').PlanStatus;
      autoMode: boolean;
      goalId: string;
      cwd: string;
      budgetUsd: number;
    }>;
    // `status`/`autoMode` are lifecycle-controlled by the dedicated endpoints
    // (approve/resume/abort/from-goal) — a generic PATCH must not flip a plan
    // to `running` behind the orchestrator's back, nor turn on full-auto
    // without the containment check. Strip them here.
    const { status: _s, autoMode: _a, ...safe } = body;
    const plan = updatePlan(opts.db, c.req.param('id'), safe);
    if (!plan) return c.json({ error: 'not found' }, 404);
    opts.router.broadcastPlanUpsert(plan);
    return c.json(plan);
  });

  app.delete('/api/plans/:id', (c) => {
    const id = c.req.param('id');
    const tasks = listPlanTasks(opts.db, id);
    const ok = deletePlan(opts.db, id);
    if (ok) {
      for (const t of tasks) opts.router.broadcastPlanTaskRemove(t.id);
      opts.router.broadcastPlanRemove(id);
    }
    return c.json({ ok });
  });

  app.post('/api/plans/:id/tasks', async (c) => {
    const planId = c.req.param('id');
    if (!getPlan(opts.db, planId)) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      prompt?: string;
      acceptanceCriteria?: string;
      dependsOn?: string[];
      assignedAdvisorRole?: string;
      cwd?: string;
      model?: string;
      budgetUsd?: number;
      orderIndex?: number;
    };
    if (!body.title || !body.prompt) {
      return c.json({ error: 'title, prompt required' }, 400);
    }
    const task = createPlanTask(opts.db, {
      planId,
      title: body.title,
      prompt: body.prompt,
      acceptanceCriteria: body.acceptanceCriteria,
      dependsOn: body.dependsOn,
      assignedAdvisorRole: body.assignedAdvisorRole,
      // Optional here: a task without its own cwd inherits the plan's.
      cwd: body.cwd ? expandHome(body.cwd) : undefined,
      model: body.model,
      budgetUsd: body.budgetUsd,
      orderIndex: body.orderIndex,
    });
    opts.router.broadcastPlanTaskUpsert(task);
    return c.json(task);
  });

  app.patch('/api/plans/:planId/tasks/:taskId', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<{
      title: string;
      prompt: string;
      acceptanceCriteria: string;
      status: import('@solix/shared').PlanTaskStatus;
      dependsOn: string[];
      assignedAdvisorRole: string;
      cwd: string;
      model: string;
      budgetUsd: number;
      orderIndex: number;
    }>;
    const task = updatePlanTask(opts.db, c.req.param('taskId'), body);
    if (!task) return c.json({ error: 'not found' }, 404);
    opts.router.broadcastPlanTaskUpsert(task);
    return c.json(task);
  });

  app.delete('/api/plans/:planId/tasks/:taskId', (c) => {
    const taskId = c.req.param('taskId');
    const ok = deletePlanTask(opts.db, taskId);
    if (ok) opts.router.broadcastPlanTaskRemove(taskId);
    return c.json({ ok });
  });

  // Task thread (P1): the task's durable run history + conversation. GET lists
  // every entry (system/worker/verifier lifecycle + human comments); POST
  // appends a human comment. Origin-gated like the other mutating routes.
  app.get('/api/plans/:planId/tasks/:taskId/thread', (c) => {
    const taskId = c.req.param('taskId');
    if (!getPlanTask(opts.db, taskId)) return c.json({ error: 'not found' }, 404);
    return c.json(listThreadEntries(opts.db, taskId));
  });

  app.post('/api/plans/:planId/tasks/:taskId/thread', async (c) => {
    const taskId = c.req.param('taskId');
    const task = getPlanTask(opts.db, taskId);
    if (!task) return c.json({ error: 'not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { body?: string };
    const text = body.body?.trim();
    if (!text) return c.json({ error: 'body is required' }, 400);
    const entry = appendThreadEntry(opts.db, {
      taskId,
      planId: task.planId,
      kind: 'comment',
      author: 'human',
      body: text,
    });
    opts.router.broadcastThreadEntry(entry);
    return c.json(entry);
  });

  // v2 Maestro — Phase 1 planner endpoints. `from-goal` runs a planner session
  // (via the orchestrator's SessionRunner), parses + validates its JSON into a
  // draft plan, and parks it at awaiting_approval; `approve` advances it to
  // running. (Dispatch is Phase 2.) Origin-gated like the other /api/* mutating
  // routes; token-gating the trigger lands with Phase-2 execution.
  app.post('/api/plans/from-goal', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      goal?: string;
      cwd?: string;
      name?: string;
      autoMode?: boolean;
      goalId?: string;
      budgetUsd?: number;
    };
    if (!body.goal || !body.cwd) {
      return c.json({ ok: false, errors: ['goal and cwd are required'] }, 400);
    }
    const res = await opts.orchestrator.createPlanFromGoal({
      goal: body.goal,
      cwd: expandHome(body.cwd),
      name: body.name,
      autoMode: body.autoMode,
      goalId: body.goalId,
      budgetUsd: body.budgetUsd,
    });
    // A run only actually dispatches when the plan reached `running` (autoMode
    // that survived the Pro + containment gates); advance() no-ops otherwise, so
    // kicking it whenever the request succeeded is safe. Never let the
    // fire-and-forget promise reject unhandled.
    if (res.ok && res.planId) kickAdvance(res.planId);
    return c.json(res, res.ok ? 200 : 422);
  });

  app.post('/api/plans/:id/approve', (c) => {
    const id = c.req.param('id');
    const res = opts.orchestrator.approvePlan(id);
    // Approved → run the dispatch loop in the background (request returns now).
    if (res.ok) kickAdvance(id);
    return c.json(res, res.ok ? 200 : 409);
  });

  // Kill-switch: abort a plan's in-flight worker/verifier and pause it.
  app.post('/api/plans/:id/abort', (c) => {
    const res = opts.orchestrator.abortPlan(c.req.param('id'));
    return c.json(res, res.ok ? 200 : 404);
  });

  // Comment-on-passage → follow-up task (P1 #4). A review comment on a file/diff
  // becomes a new worker task on the same plan; a settled plan is reopened to run
  // it (re-gated in the orchestrator). Origin-gated like the other mutators.
  app.post('/api/plans/:id/follow-up', (c) => {
    return (async () => {
      const id = c.req.param('id');
      const body = (await c.req.json().catch(() => ({}))) as {
        body?: string;
        file?: string;
        hunk?: string;
        sourceTaskId?: string;
        title?: string;
      };
      if (!body.body || !body.body.trim()) {
        return c.json({ ok: false, error: 'comment body is required' }, 400);
      }
      const res = opts.orchestrator.addFollowUpTask(id, {
        body: body.body,
        file: body.file,
        hunk: body.hunk,
        sourceTaskId: body.sourceTaskId,
        title: body.title,
      });
      if (res.run) kickAdvance(id);
      // 200 on success (incl. queued), 402 when adding it needs Pro to run,
      // 404 for an unknown plan.
      const status = res.ok ? 200 : res.error === 'plan not found' ? 404 : 400;
      return c.json(res, status);
    })();
  });

  // Resume a paused plan (budget pause / abort).
  app.post('/api/plans/:id/resume', (c) => {
    const id = c.req.param('id');
    const res = opts.orchestrator.resumePlan(id);
    if (res.ok) kickAdvance(id);
    return c.json(res, res.ok ? 200 : 409);
  });

  // Build-studio review surface: what the fleet changed on disk since the plan
  // started (git diff of plan.cwd vs the baseline captured at run start).
  app.get('/api/plans/:id/review', (c) => {
    const plan = getPlan(opts.db, c.req.param('id'));
    if (!plan) return c.json({ ok: false, error: 'plan not found' }, 404);
    return c.json(buildPlanReview(plan.cwd, plan.baseRef));
  });

  // Build-studio preview: serve the built result (static files) straight from
  // the plan's working tree so the user can SEE what was built. Read-only GET,
  // strictly confined to plan.cwd (path-traversal guarded). For static sites;
  // running dev servers for node/python is deliberately out of scope for now.
  const servePreview = (c: import('hono').Context): Response => {
    const plan = getPlan(opts.db, c.req.param('id') ?? '');
    if (!plan) return new Response('not found', { status: 404 });
    const rest = c.req.param('rest') ?? '';
    // Containment: the resolved path must stay inside the project (pure guard).
    let target = previewTargetPath(plan.cwd, rest);
    if (target == null) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      if (existsSync(target) && statSync(target).isDirectory()) {
        target = join(target, 'index.html');
      }
    } catch {
      /* fall through to the not-found handling below */
    }
    if (!existsSync(target)) {
      return new Response(
        `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0b0e17;color:#cbd5e1;padding:3rem"><h2>Nothing to preview yet</h2><p>This project has no <code>index.html</code>. Preview supports static sites; run other stacks from a terminal.</p></body>`,
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
      );
    }
    // Defense in depth: the lexical guard above can be defeated by an in-tree
    // symlink (a worker could create `cwd/link -> /`), so resolve symlinks and
    // re-check that the REAL target is still inside the REAL project root.
    try {
      const realRoot = realpathSync(resolve(plan.cwd));
      const realTarget = realpathSync(target);
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
        return new Response('forbidden', { status: 403 });
      }
    } catch {
      return new Response('forbidden', { status: 403 });
    }
    // Cap the served file size to keep the local server responsive.
    if (statSync(target).size > 25 * 1024 * 1024) {
      return new Response('file too large to preview', { status: 413 });
    }
    return new Response(readFileSync(target), {
      headers: { 'Content-Type': mimeFor(target) },
    });
  };
  app.get('/api/plans/:id/preview', servePreview);
  app.get('/api/plans/:id/preview/:rest{.*}', servePreview);

  // Preflight check used by the NewTaskModal to warn before the user
  // clicks Launch. Cached for the process lifetime — installing claude
  // requires a server restart anyway.
  let preflightCache: {
    claudeAvailable: boolean;
    version?: string;
    agentViewAvailable: boolean;
  } | null = null;
  app.get('/api/system/preflight', (c) => {
    if (preflightCache) return c.json(preflightCache);
    try {
      const res = spawnSync('claude', ['--version'], {
        timeout: 2000,
        encoding: 'utf8',
      });
      if (res.status === 0) {
        const version = (res.stdout ?? '').trim() || undefined;
        preflightCache = {
          claudeAvailable: true,
          version,
          agentViewAvailable: isAgentViewVersion(version),
        };
      } else {
        preflightCache = { claudeAvailable: false, agentViewAvailable: false };
      }
    } catch {
      preflightCache = { claudeAvailable: false, agentViewAvailable: false };
    }
    return c.json(preflightCache);
  });

  // Serve the built web bundle as static when present so `solix start` is one
  // process that gives you the API + WS + UI on a single URL.
  const webDist = findWebDist();
  if (webDist) {
    app.get('*', (c) => {
      const url = new URL(c.req.url);
      // Skip API routes — they're handled above; this is the SPA catch-all.
      if (
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/events') ||
        url.pathname.startsWith('/ws')
      ) {
        return c.notFound();
      }

      const safe = url.pathname.replace(/\.\.+/g, '.');
      const candidate = join(webDist, safe === '/' ? 'index.html' : safe);
      // A request for a FILE (anything with an extension) that doesn't exist is
      // a missing asset, not a client-side route — 404 it instead of handing
      // back index.html. Serving HTML under a .jpg/.js URL doesn't just hide
      // the problem, it corrupts it: the browser tried to decode index.html as
      // a texture, `useLoader` threw, and the whole app went blank. A clean 404
      // degrades properly and makes the real fault obvious in devtools.
      const looksLikeAsset = /\.[a-z0-9]+$/i.test(safe);
      if (looksLikeAsset && !existsSync(candidate)) {
        return c.notFound();
      }
      let filePath = candidate;
      try {
        if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
          filePath = join(webDist, 'index.html');
        }
      } catch {
        filePath = join(webDist, 'index.html');
      }
      if (!existsSync(filePath)) return c.notFound();
      const data = readFileSync(filePath);
      return new Response(data, {
        headers: { 'Content-Type': mimeFor(filePath) },
      });
    });
  }

  app.get('/api/galaxy/registry/status', (c) =>
    c.json({
      configured: registry.isConfigured(),
      url: process.env.SOLIX_REGISTRY_URL ?? null,
    }),
  );

  app.get('/api/galaxy/registry', async (c) => {
    const slugs = await registry.listSlugs();
    return c.json({ slugs });
  });

  app.get('/api/galaxy/registry/:slug', async (c) => {
    const slug = c.req.param('slug');
    try {
      const manifest = await registry.pull(slug);
      return c.json(manifest);
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  app.post('/api/galaxy/registry/:slug/install', async (c) => {
    const slug = c.req.param('slug');
    try {
      const manifest = await registry.pull(slug);
      const result = importManifest(opts.db, manifest, `registry:${slug}`);
      opts.router.broadcastGalaxyImported(manifest);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  // (helpers defined at module bottom)

  app.post('/api/galaxy/publish', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      slug?: string;
      name?: string;
      author?: string;
      description?: string;
    };
    if (!body.slug) {
      return c.json({ error: 'slug required' }, 400);
    }
    const manifest = exportManifest(opts.db, {
      name: body.name,
      author: body.author,
      description: body.description,
    });
    try {
      const published = await registry.publish(body.slug, manifest);
      return c.json({ ok: true, ...published });
    } catch (err) {
      return c.json({ error: String(err) }, 502);
    }
  });

  return app;
}

function findWebDist(): string | null {
  if (process.env.SOLIX_WEB_DIST) {
    return existsSync(process.env.SOLIX_WEB_DIST)
      ? process.env.SOLIX_WEB_DIST
      : null;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // Bundled npm package: web/ ships next to the bundled JS file.
    resolve(here, 'web'),
    // Monorepo: server's compiled output is at packages/server/dist.
    resolve(here, '..', '..', 'web', 'dist'),
    resolve(here, '..', '..', '..', 'web', 'dist'),
    resolve(here, '..', '..', '..', 'packages', 'web', 'dist'),
    resolve(process.cwd(), 'packages', 'web', 'dist'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return null;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function mimeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}
