# Solix — for developers

## 30-second pitch

You're running 3+ Claude Code sessions in different terminals. You've
lost track of which one's blocked on a permission prompt, which one
ran out of context an hour ago, which files were touched in the last
mission. **Solix is a local server + WebSocket + R3F frontend that
ingests Claude Code's hook events and renders every session as a
planet orbiting a sun.** Status (active / awaiting permission /
context-bloated / plan review) is encoded as visual properties — color,
emissive, halo, size — so you read it in <100 ms instead of scrolling a
log. Bonus: a built-in roster of 14 role-based advisor agents, a real
asteroid belt of skills (Anthropic + bundled), and a galaxy-manifest
share format so a team's AI workflow becomes a versioned artifact.

The metaphor is in [PRD §2](#); the rest of this doc is what you'd
need to evaluate, run, and extend it.

---

## Quick start

```sh
git clone https://github.com/shmulikdav/Solix.git
cd Solix
pnpm install
pnpm --filter @solix/web build
pnpm --filter @shmulikdav/solix exec tsx src/index.ts start
# in another terminal — populates the scene without needing claude installed:
pnpm --filter @shmulikdav/solix exec tsx src/index.ts demo
```

Open `http://127.0.0.1:4242`. To wire into a real Claude Code session:
`solix install` patches `~/.claude/settings.json` with the 9 hook
scripts (idempotent merge; backs up first), then `claude` anywhere
spawns a planet within 1 s.

---

## Architecture

```
 ┌────────────────────┐                         ┌──────────────────┐
 │  claude (terminal) │                         │   browser (R3F)  │
 └─────────┬──────────┘                         └────────▲─────────┘
           │ hook event (sync, on stdin)                 │ WebSocket
           ▼                                             │ /ws
 ┌────────────────────┐    POST /events    ┌─────────────┴────────┐
 │  ~/.solix/hooks/   │ ─────────────────► │  Hono server :4242   │
 │  *.sh (curl)       │  --max-time 1      │  (Node.js)           │
 └────────────────────┘  always exit 0     └─────────────┬────────┘
                                                         │
                                          ┌──────────────┴───────┐
                                          │ EventRouter ─► state │
                                          │ ~/.solix/solix.db    │
                                          │ (better-sqlite3 WAL) │
                                          └──────────────┬───────┘
                                                         │ broadcast
                                                         ▼
                                                  Broadcaster (ws)
```

Source of truth is SQLite. Hooks are fire-and-forget. The server
serves API + WS + the built web/dist on the same port.

---

## The 9 hook events

Definitions: `packages/shared/src/events.ts:1` (HOOK_EVENTS const).
Hook shell scripts: `packages/cli/hooks/*.sh` — each one is the same
~10-line POSIX `curl` template with the event name baked in.

| Hook event | Router method | Triggers broadcast |
|---|---|---|
| `session_start` | `onSessionStart` (`router.ts:109`) | `session_upsert` |
| `user_prompt_submit` | `onUserPromptSubmit` | `mission_upsert` + `session_upsert` |
| `pre_tool_task` | `onPreToolTask` | spawns moon (`session_upsert`) |
| `pre_tool_file` | `onPreToolFile` | `tool_call` + tracks `filesTouched` |
| `pre_tool_bash` | `onPreToolBash` | `tool_call` |
| `post_tool` | `onPostTool` | bumps mission counters |
| `notification` | `onNotification` | `permission_request` (red flare) |
| `subagent_stop` | `onSubagentStop` | `session_remove` (moon collapses) |
| `stop` | `onStop` | mission complete + planet idle |

---

## Data model

`packages/shared/src/types.ts` — read it; everything is in one file.

The shape that matters most:

```ts
// types.ts:17
interface Session {
  id: string; pid: number; cwd: string; projectId: string;
  status: SessionStatus;       // 7 states
  model: Model;                // opus | sonnet | haiku | default
  origin: 'external' | 'internal';
  kind: 'user' | 'advisor';    // splits inner ring vs. outer zone
  advisorRole?: string;        // 'compass' | 'forge' | … when kind === 'advisor'
  parentSessionId?: string;    // set if this is a moon (subagent)
  contextUsagePct: number;     // 0–100; drives planet scale + flare
  currentMissionId?: string;
  orbitSlot: number;           // assigned at spawn; stable layout
  createdAt: number; updatedAt: number;
}
```

Other types worth scanning: `Mission` (line 48 — `metrics.toolCallCount`,
`filesTouched[]`), `Advisor` (108), `Skill` (126), `GalaxyManifest`
(157).

SQLite schema mirrors these 1:1 — see
`packages/server/src/db.ts`. Migrations are an idempotent column-add
helper (`ensureColumn`) for upgrading repos in place.

---

## WebSocket protocol

`packages/shared/src/protocol.ts:13` (`ServerMessage`),
`:45` (`ClientMessage`). Discriminated unions on `type`.

| Direction | Type | When |
|---|---|---|
| ⇩ snapshot | `snapshot` | on connect — full state dump |
| ⇩ session | `session_upsert` / `session_remove` | every router state change |
| ⇩ mission | `mission_upsert` | start / progress / complete |
| ⇩ tool | `tool_call` | every PreToolUse — drives comet streaks |
| ⇩ permission | `permission_request` | hook `notification` fires |
| ⇩ context | `context_update` | when contextUsagePct changes |
| ⇩ advisor | `advisor_upsert` | enable / disable / pin / unpin |
| ⇩ galaxy | `galaxy_imported` | after import succeeds |
| ⇩ toast | `toast` | misc UX-level notifications |
| ⇧ permission | `permission_response` | user approve / deny |
| ⇧ advisor | `invoke_advisor` / `pin_advisor` / `unpin_advisor` | UI actions |
| ⇧ session | `send_prompt` / `terminate_session` | M3.5 (stubbed) |

The store reducer at `packages/web/src/store/index.ts` (Zustand) is
the canonical client-side handler.

---

## Three design decisions worth knowing about

### 1. Hook fail-open

Every shell hook follows this pattern (`packages/cli/hooks/session-start.sh`):

```sh
SOLIX_PORT="${SOLIX_PORT:-4242}"
EVENT="session_start"
PAYLOAD=$(cat 2>/dev/null || echo '{}')
[ -z "$PAYLOAD" ] && PAYLOAD='{}'
TS=$(date +%s%3N 2>/dev/null || echo "0")
curl -s -X POST "http://127.0.0.1:${SOLIX_PORT}/events" \
  -H "Content-Type: application/json" \
  -d "{\"event\":\"$EVENT\",\"payload\":$PAYLOAD,\"pid\":$PPID,\"cwd\":\"$(pwd)\",\"ts\":$TS}" \
  --max-time 1 > /dev/null 2>&1 || true
exit 0
```

Three load-bearing properties:
- `--max-time 1` — never blocks Claude Code if Solix is down
- `|| true` + `exit 0` — non-zero exit from a hook can block tool use
- stdout/stderr redirected — hooks must not pollute Claude's output

The HTTP server matches: `/events` always returns 200, even on
malformed payloads (`packages/server/src/http.ts` ingest path).

### 2. Context envelope on advisor invoke

Mission summaries are the handoff currency, not transcripts.

```ts
// packages/server/src/state/context.ts:73
export function buildContextEnvelope(
  db: DB,
  args: { advisorId; targetSessionId?; userPrompt? },
): ContextEnvelope | null
```

The envelope stitches:
- the advisor's role description
- the focused planet's cwd / model / status / context %
- the last 3 missions' `shortName` + `longSummary` + `filesTouched`
- a role-specific default ask (PM, Builder, UX, etc.)
- a `/compact` suggestion if the target ≥90%

Cost is O(missions per planet ≤ 3). Statelessness means the same
prompt is reproducible from DB without replaying transcripts. The
preview endpoint (`GET /api/advisors/:id/preview`) is what the
AdvisorPanel renders before you hit Invoke.

### 3. Kind-tagged sessions for the inner crew ring

`Session.kind = 'user' | 'advisor'` splits rendering:

- `selectPlanets()` — outer working zone (user sessions)
- `selectAdvisorPlanets()` — outer zone, but tagged `kind: advisor`
  (a pinned advisor)
- `<AdvisorRing />` — inner crew ring (read from
  `advisors` table, not `sessions`)

When `Launcher.pin(advisorId, cwd)` spawns a `claude --agent <id>`
child process, it caches `pid → advisorRole`.
`router.onSessionStart` consults that map (`router.ts:109`):

```ts
const advisorRole = this.launcher?.advisorRoleForPid(event.pid);
const session = upsertSession(this.db, {
  ...,
  kind: advisorRole ? 'advisor' : 'user',
  advisorRole,
});
```

Result: the same hook → router → broadcast pipeline serves both user
sessions and pinned advisors with no duplication. The visual
treatment (gold accent ring on advisor planets in
`Planet.tsx`) is the only divergence.

For dev environments without a real `claude` binary, set
`SOLIX_FAKE_CLAUDE=1` — the launcher creates a synthetic session
record so the visuals work.

---

## Extending Solix

### Add a custom advisor

1. Write a `.md` file in `packages/agents/` with Claude Code subagent
   frontmatter (look at `compass.md` for a model). Required: `name`,
   `description`, `model`, `tools`.
2. Append an entry to `packages/agents/manifest.json` with `id`,
   `role`, `codename`, `description`, `glyph`, `color`,
   `defaultModel`, `agentMd`, `enabledByDefault`, `requiredSkills`.
3. Add the role's default ask to `DEFAULT_ASKS` in
   `packages/server/src/state/context.ts` so `Invoke` produces a
   sensible envelope.
4. Run `solix install` (copies the .md into `~/.claude/agents/`) and
   restart the server (re-runs `seedAdvisors`).

Or, for a one-off: drop the .md in `~/.claude/agents/` directly and
ignore the Solix registry — Claude Code's subagent system picks it
up; you just won't see it on the inner ring.

### Add a custom skill

```sh
mkdir -p ~/.solix/skills/my-skill
cat > ~/.solix/skills/my-skill/SKILL.md <<'EOF'
---
name: my-skill
description: One-line behavioral description.
---

# my-skill

Body of the skill prompt.
EOF
```

Restart the server. The discovery scan
(`packages/server/src/state/skills.ts`) picks it up and you'll see a
new asteroid in the belt. To require it from an advisor, add the skill
id to `requiredSkills` in `manifest.json`.

### Tap into the WebSocket from outside

A 10-line external client:

```ts
import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:4242/ws');
ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type === 'session_upsert') {
    console.log('[solix]', msg.session.kind, msg.session.id, '→', msg.session.status);
  }
});
```

This is the integration hook for any external dashboard, Slack
relay, dev container telemetry, etc.

---

## CLI reference

| Command | Purpose |
|---|---|
| `solix start` | Server + WS + UI on `:4242` |
| `solix install` | Patch `~/.claude/settings.json`; copy hooks, advisors, skills |
| `solix uninstall` | Restore from backup |
| `solix doctor` | Diagnostics (Node version, hooks installed, server reachable, advisor count, skill count) |
| `solix demo` | Seed a fully populated galaxy (~30 sessions across 8 projects, all 14 advisors, missions, comets, permission flares, context flares, moons) + a live ticker |
| `solix advisors {list,enable,disable,pin,unpin}` | Crew management |
| `solix skills {list,install --project}` | Asteroid belt |
| `solix galaxy {export,import,publish,install}` | Manifest share + opt-in registry |

`solix --help` for full surface. All commands are HTTP clients of the
running server (except `start` / `install` / `uninstall`), so they're
trivial to wrap, script, or replace.

---

## Honest tradeoffs (what's not done yet)

- **Transcript-tail watcher.** `Session.contextUsagePct` is plumbed
  through (DB, broadcast, planet scale, threshold flares), but the
  populator — a `chokidar` watcher on
  `~/.claude/projects/<project>/<session>.jsonl` that sums tokens —
  isn't written yet. PRD §5.5 / M3 work. The demo seeder pushes
  values via `POST /api/sessions/:id/context` so the visuals can be
  exercised.
- **No tests.** Mira (the QA advisor) exists, but the suite is
  empty. The hook → router → broadcast pipeline has been smoke-tested
  end-to-end against a live server (curl + ws); there's nothing in
  CI yet.
- **Single bundle, ~300 KB gzip.** Vite warns at 500 KB; we're under
  that. Code-splitting GalaxyPanel and SkillPanel via
  `React.lazy` would be a quick win.
- **Pin is `claude --agent <id>`.** That flag may not match every
  installed version of Claude Code. `SOLIX_FAKE_CLAUDE=1` works in
  dev mode (synthetic session). Production users may need to swap
  the launcher's spawn args.
- **No auth on the local HTTP server.** `127.0.0.1:4242` trusts
  anything on loopback. Fine for single-user local; bad for shared
  hosts. PRD §17.

---

## Where the code lives

```
packages/
├── shared/   types + protocol shared across server/web/cli
├── server/   Hono + WebSocket + SQLite + EventRouter + Launcher + cloud
├── web/      React + r3f scene + advisor ring + asteroid belt + panels
├── cli/      commander + hook scripts (.sh)
├── agents/   advisor .md files + manifest.json
└── skills/   bundled SKILL.md manifests
```

Each package builds independently (`pnpm -r typecheck` runs all four).
Workspace deps via pnpm, no lerna/turbo.

---

## Performance ceilings

- Designed for 60 fps with 20 simultaneous planets per PRD acceptance
  (§13). Profiled at ~10 in practice — not stress-tested at 50.
- Asteroid belt uses `<instancedMesh>` so N skills is essentially
  free. Comet layer is per-instance — would want to instance if it
  ever exceeds ~50 active comets.
- SQLite WAL mode; haven't measured peak hook ingestion rate. A
  reasonable upper bound: `claude` fires ~1–10 events/sec sustained;
  WAL handles that fine.
- Bundle: 1.0 MB raw / 300 KB gzip. Most of it is three.js + drei.
  No code splitting yet.

---

## When Solix is a fit / when it isn't

**Use it when:**
- You routinely have ≥3 simultaneous Claude Code sessions
- You want shared team standards for AI workflow (galaxy export)
- You like at-a-glance status over scrolling logs
- You'd build something like this anyway and want a head start

**Skip it when:**
- You only ever run one `claude` at a time (the metaphor is
  overkill)
- You don't use Claude Code (no other agent runtime is supported
  yet)
- You can't run a local Node service (containerized dev environments
  with no port forwarding)
- You want a single-binary install — Solix is currently npm + pnpm
  install + manual hook install, not a one-shot

---

PRs welcome. The branch this doc ships on is
`claude/solix-command-center-z1y95`. Mira would like a test suite.
