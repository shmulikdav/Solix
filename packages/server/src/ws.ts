import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '@solix/shared';
import type { Broadcaster } from './broadcaster.js';
import type { DB } from './db.js';
import type { EventRouter } from './router.js';
import { listProjects } from './state/projects.js';
import { listActiveSessions } from './state/sessions.js';
import { listMissions } from './state/missions.js';
import { listAdvisors } from './state/advisors.js';
import { listSkills } from './state/skills.js';
import { listSchedules } from './state/schedules.js';
import { listGoals } from './state/goals.js';
import { listPlans, listPlanTasks } from './state/plans.js';
import { isAllowedOrigin } from './origins.js';

export interface WsContext {
  db: DB;
  router: EventRouter;
  broadcaster: Broadcaster;
}

export function attachWs(server: HttpServer, ctx: WsContext): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on(
    'upgrade',
    (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const url = req.url ?? '';
      if (!url.startsWith('/ws')) {
        socket.destroy();
        return;
      }
      // The WS control plane accepts launch_session / send_prompt / invoke,
      // and browsers don't apply CORS to the WebSocket handshake — so without
      // this check any page the user visits could open ws://127.0.0.1:4242/ws
      // and drive their agents. Browsers always send Origin on the handshake;
      // reject anything that isn't a loopback origin. (Non-browser WS clients
      // send no Origin and are allowed.)
      if (!isAllowedOrigin(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    },
  );

  wss.on('connection', (ws: WebSocket) => {
    ctx.broadcaster.add(ws);

    const snapshot: ServerMessage = {
      type: 'snapshot',
      projects: listProjects(ctx.db),
      sessions: listActiveSessions(ctx.db),
      missions: listMissions(ctx.db, { limit: 100 }),
      advisors: listAdvisors(ctx.db),
      skills: listSkills(ctx.db),
      schedules: listSchedules(ctx.db),
      goals: listGoals(ctx.db),
      plans: listPlans(ctx.db),
      planTasks: listPlanTasks(ctx.db),
    };
    ctx.broadcaster.send(ws, snapshot);

    // Replay any pending permission requests so a fresh client immediately
    // sees them in the Decision Queue. Otherwise the broadcast that
    // delivered them happened before this connection opened and they'd be
    // lost on reload.
    for (const p of ctx.router.pendingPermissions()) {
      ctx.broadcaster.send(ws, {
        type: 'permission_request',
        sessionId: p.sessionId,
        tool: p.tool,
        args: p.args,
        requestId: p.requestId,
      });
    }

    ws.on('message', (raw) => {
      let msg: ClientMessage | null = null;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        return;
      }
      if (!msg) return;
      handleClientMessage(ctx, ws, msg);
    });

    ws.on('close', () => {
      ctx.broadcaster.remove(ws);
    });

    ws.on('error', () => {
      ctx.broadcaster.remove(ws);
    });
  });

  return wss;
}

function handleClientMessage(
  ctx: WsContext,
  _ws: WebSocket,
  msg: ClientMessage,
): void {
  switch (msg.type) {
    case 'permission_response':
      ctx.router.resolvePermission(msg.requestId, msg.approved);
      break;
    case 'terminate_session':
      // M3.5: hand off to launcher; for M0 we just mark terminated.
      break;
    case 'send_prompt':
      ctx.router.sendPromptToSession(msg.sessionId, msg.text);
      break;
    case 'launch_session':
      ctx.router.launchInternalSession({
        cwd: msg.cwd,
        model: msg.model,
        initialPrompt: msg.initialPrompt,
        worktreeBranch: msg.worktreeBranch,
        worktreeBaseRef: msg.worktreeBaseRef,
        useAgentView: msg.useAgentView,
        agentName: msg.agentName,
        budgetUsd: msg.budgetUsd,
        goalId: msg.goalId,
      });
      break;
    case 'raise_budget':
      ctx.router.raiseBudget(msg.sessionId, msg.budgetUsd);
      break;
    case 'dismiss_budget_alert':
      // Client-side only — the store removes the alert. No server state.
      break;
    case 'invoke_advisor':
      ctx.router.invokeAdvisor(
        msg.advisorId,
        msg.targetSessionId,
        msg.prompt,
      );
      break;
    case 'pin_advisor':
      ctx.router.pinAdvisor(msg.advisorId);
      break;
    case 'unpin_advisor':
      ctx.router.unpinAdvisor(msg.advisorId);
      break;
    case 'set_advisor_enabled':
      ctx.router.setAdvisorEnabled(msg.advisorId, msg.enabled);
      break;
    default:
      break;
  }
}
