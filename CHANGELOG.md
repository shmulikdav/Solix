# Changelog

All notable changes to Solix (`@shmulikdav/solix`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.12.0] — 2026-09-23

**Maestro (preview): describe a goal, watch your agent fleet build it — 100% local.**

Solix goes from observing agents to *orchestrating* them. All of v2 is additive;
the paid tier ships dormant (free public beta — everything unlocked).

### Added
- **Maestro orchestrator.** Give a goal → a planner decomposes it into a task
  plan you approve → Solix dispatches one Claude session per task (each its own
  planet), verifies each result against acceptance criteria, retries with
  feedback, and drives the build to done. New Plan panel (press `P` / ✷ Maestro)
  and dispatch beams in the galaxy.
- **Build studio.** Create a project in-app (scaffold + `git init`), let Maestro
  build into it, review the real diff of what changed, preview the result, and
  iterate with a follow-up goal.
- **Governed autonomy.** A kill-switch, per-plan budget cap, and a
  safe-by-default command denylist (blocks `rm -rf /`, out-of-cwd writes, etc.)
  govern every worker with no setup; a per-run full-auto toggle for trusted flows.
- **Pro licensing (dormant).** Offline, signature-verified license support +
  `solix license activate` — off by default (free beta); nothing to buy yet.
- **Tests + CI.** A test suite (152 tests) and PR-gating CI, from zero.

### Notes
- The Pro gate is inert until enforcement is turned on — this release changes
  nothing for existing users.

## [1.11.7] — 2026-09-04

**Launch hardening: `solix demo` can't get stuck, and the UI tells you when it's stale.**

### Fixed
- **`solix demo` no longer gets permanently stuck after a failed run.** A demo that
  failed to start used to leave its sandbox server orphaned (a `SIGTERM` that a
  mid-boot process could ignore), and only the most recent PID was ever cleaned up — so
  orphans piled up, held the port and the sandbox DB, and made every later run fail. Now
  the demo reaps **all** stale sandbox servers on startup and kills its own child
  reliably (SIGTERM → SIGKILL) on both failure and Ctrl+C, so a bad run can never
  poison the next one.
- **Clearer demo startup error.** Instead of a generic "failed to start", the demo now
  says whether the server *crashed* (pointing you at the error above) or *started but
  isn't reachable* (pointing at a firewall / security tool blocking localhost, or a
  stuck server) — with a suggestion to try a fresh `--port`.

### Added
- **"New version — Reload" banner.** When the running Solix server is newer than the UI
  bundle your browser is showing (a stale service worker / cached shell after an
  upgrade), a banner now offers a one-click hard refresh (unregister service workers +
  clear caches + reload) — no more hunting through DevTools to see a shipped fix.

## [1.11.6] — 2026-09-04

### Fixed
- **The New Task modal no longer runs off the top/bottom of the screen.** On shorter
  windows the form grew to its full content height and overflowed the viewport (the
  title and footer were clipped). It now uses the same centered, height-capped layout
  as the Crew roster — pinned header and footer with the form scrolling in between —
  so it always fits on screen with the Launch button reachable.

## [1.11.5] — 2026-09-04

**The demo starts reliably even with a large Agent View history.**

### Fixed
- **`solix demo` no longer stalls when `~/.claude/jobs` is large.** 1.11.4 fixed the
  `CHECK` error that had been silently *aborting* Agent View sync — which, as a side
  effect, meant sync then did real work: on boot it scanned the entire `~/.claude/jobs`
  and inserted every session in one synchronous burst, freezing the server long enough
  that the demo's health check timed out (now even at 30s). Two fixes:
  - The demo sandbox now runs fully isolated from your real Agent View state
    (`SOLIX_DISABLE_AGENTVIEW`) — it has its own seeded database and shouldn't mirror
    external sessions into it, nor scan a heavy jobs directory in a throwaway sandbox.
  - For real `solix start`, the initial Agent View scan now yields to the event loop as
    it goes, so a large jobs directory never blocks the server from responding —
    sessions stream in as they're found instead of arriving in one freeze.

## [1.11.4] — 2026-09-03

**`solix demo` starts reliably, and Agent View sessions finally sync.**

### Fixed
- **`solix demo` no longer fails with "sandbox server failed to start within 8s."** On a
  cold first run (right after `npm i -g`), the server does all of its boot work
  synchronously before binding the port — loading the native SQLite addon, seeding
  advisors, scanning skills, and scanning `~/.claude/jobs` for Agent View. On a busy
  machine that could exceed the 8s the demo waited, so it killed a server that was about
  to be ready. The demo now waits up to 30s, and the initial Agent View scan is deferred
  off the boot path so the port answers immediately.
- **Agent View background sessions now appear as planets.** The `sessions.origin` column
  had a leftover `CHECK (origin IN ('external','internal'))` that rejected Agent View's
  `'agentview'` origin — so every sync threw `CHECK constraint failed` and no background
  session ever showed up. The constraint is removed for new databases and relaxed
  in-place (data-preserving) on existing ones, so upgrading installs pick up their Agent
  View sessions on the next start. This also unblocks future multi-tool origins.

## [1.11.3] — 2026-09-02

### Changed
- **Soft galaxy behind the modals.** With the label z-index fixed in 1.11.2, the New
  Task / Crew modal backdrop no longer needs to be opaque to stay clean — restored a
  dimmed, blurred galaxy behind them for the "floating in space" look, with the form
  still fully readable.

## [1.11.2] — 2026-09-02

### Fixed
- **Galaxy labels no longer float over the modals — the *actual* fix for "the galaxy
  shows through the New Task / Crew forms."** The planet and project name labels are
  drei `<Html>` overlays, which default to a z-index in the millions, so they rendered
  *on top of* the centered modals — it was never the panel background (which is opaque).
  The labels are now pinned to a low z-index (`zIndexRange`), keeping them in the galaxy
  layer beneath the HUD and all panels.

## [1.11.1] — 2026-09-02

### Fixed
- **Modal backdrop is now fully solid.** 1.11.0 dimmed the New Task / Crew modal
  backdrop to 90%, but on some setups a faint galaxy still showed through the panel. The
  backdrop is now the solid app background, so the scene is completely hidden behind the
  modal and the form is always fully readable.

## [1.11.0] — 2026-09-02

**More models to pick from, and the modals stop showing the galaxy through them.**

### Added
- **Claude 5 model options in the New Task picker.** Alongside the auto-updating tier
  aliases (default / opus / sonnet / haiku), you can now pin **Opus 5, Sonnet 5, Haiku 4.5,
  and Fable 5.1** explicitly. Planets stay color-coded by tier (Fable gets its own pink).
  Pinned model ids only launch if your Claude Code + plan can access them.

### Fixed
- **Galaxy no longer bleeds through the New Task / Crew modals.** The opaque panel was
  nested inside a `backdrop-blur` element, which some browsers composite translucently, so
  the busy scene showed through the form (worst in the dense center). The blurred backdrop is
  now a sibling layer behind the panel (matching the docked panels that never bled), and it's
  darkened so the panel reads solid.

## [1.10.0] — 2026-09-02

**The sun comes alive — click it for Mission Control.**

### Added
- **Clickable sun → "Mission Control."** The central sun was decorative; now
  clicking it (or pressing `w`) opens a right-docked overview of the whole
  workspace: total spend, cost per completed mission, interventions (from the
  audit log), active / needs-you / idle counts, mission tallies, context
  pressure, and a clickable "needs-you" list that jumps you to whichever agent
  is waiting. All figures are real — no new tracking.
- **A living star.** The sun's light brightens and it grows slightly as more
  agents work, and its solar flares flick faster and redder whenever a session
  needs a human — so the center of the screen signals status before you click.

## [1.9.3] — 2026-09-02

**Decision-card polish and a crew self-heal salvaged from earlier PRs.**

### Fixed
- **Decision-Queue cards are fully opaque** ([#7](https://github.com/shmulikdav/Solix/pull/7)). The permission and budget cards used a translucent `bg-solix-danger/10`, so the galaxy bled through them; they're now solid, keeping the red border and header as the danger signal.
- **Crew roster self-heals, plus a boot diagnostic** ([#5](https://github.com/shmulikdav/Solix/pull/5)). The Crew panel re-reads `/api/advisors` on open, so it populates even when the initial WebSocket snapshot arrives empty; and the server logs its resolved DB path with advisor/session counts at startup, making "empty UI" reports diagnosable in one line.

## [1.9.2] — 2026-09-02

**macOS observability fix — hooks work on BSD `date`, and status pings stop opening "unknown" permission cards.**

### Fixed
- **macOS: session and tool observability were silently broken** ([#2](https://github.com/shmulikdav/Solix/issues/2)). On macOS a fresh `solix install` left the dashboard stuck on "EMPTY SYSTEM" — no planets, no comets — with no error anywhere. Three combined causes, all fixed:
  - 6 of the 9 hook scripts POSTed to the token-guarded `/events` endpoint **without** the `X-Solix-Token` header, so every event got a 401 and was silently swallowed. All 9 hooks now send the token.
  - Every hook built its timestamp with `date +%s%3N`; `%N` is a GNU extension, so BSD `date` on macOS emitted a literal `N` and produced invalid JSON the server dropped. Hooks now use POSIX arithmetic (`$(($(date +%s) * 1000))`), which yields millisecond timestamps on both BSD and GNU.
  - `Notification` events were all treated as permission requests, so Claude Code's benign "waiting for your input" pings rendered as **"unknown"** Approve/Deny modals and flipped the planet red. The server now promotes a notification to a permission decision only when it carries a `tool_name`; otherwise it just surfaces a toast.
- **Panels and modals are fully opaque.** The `solix.panel` color had baked-in alpha, capping every `bg-solix-panel/NN` at 0.8 so scene labels bled through the modals; it's now a solid color, with darker modal backdrops ([#3](https://github.com/shmulikdav/Solix/pull/3)).

Thanks to the detailed macOS onboarding report in [#2](https://github.com/shmulikdav/Solix/issues/2).

## [1.9.1] — 2026-09-01

**Getting-started docs go npm-first, and the stale-UI service-worker trap is fixed.**

### Fixed
- **PWA service worker no longer precaches the app shell.** After a `solix`
  upgrade (or a rebuild) the service worker used to keep serving the old
  JS/CSS/HTML bundle until it eventually revalidated, making shipped fixes look
  like they hadn't landed. The shell now always comes fresh from the local
  server — which is always up whenever the UI is — and only the icons/manifest
  are precached, for installability (`navigateFallback: null`). Precache dropped
  from 13 entries (~1.3 MiB) to 6 (~96 KiB).

### Changed
- **Getting-started guides are npm-first.** `DEMO.md` and `DEMO_PM.md` now start
  from `npm i -g @shmulikdav/solix` instead of cloning the repo, and drop the
  from-source `pnpm install` / build steps and the `cd ~/Solix` references.
  `DEMO_DEV.md` remains the from-source developer guide.

### Added
- **Launch banner** (`docs/galaxy.png`) for the README hero and launch listings,
  re-rendered lighter (1.26 MB → 788 KB).

## [1.9.0] — 2026-08-31

**Live showcase demo, cross-origin hardening, and launch-readiness fixes.**

### Added
- **Live showcase demo.** `solix demo` now boots its own sandboxed server
  (isolated `~/.solix/demo.db`), seeds a saturated galaxy (~30 sessions across
  8 projects, all 14 advisors, missions, comets, moons, permission flares),
  and runs a continuous ticker until Ctrl+C — a fully synthetic showcase that
  needs no real Claude Code. `--no-ticker` seeds a static snapshot; `--keep`
  preserves the sandbox DB; `--no-server` seeds against a server you already
  have running.

### Security
- **Closed the cross-origin control-plane hole.** The install token guarded
  only `/events`, while `/ws` and every `/api/*` route were open — and because
  browsers don't CORS-check WebSocket handshakes (and can send "simple"
  cross-origin POSTs), any page a user merely visited could open
  `ws://127.0.0.1:4242/ws` or POST to process-spawning routes and drive their
  agents. A loopback **Origin allowlist** now gates the WS upgrade and all
  state-changing HTTP requests (non-browser callers with no Origin — hooks,
  `curl`, `solix demo` — are unaffected), plus an **SSRF guard** on
  `POST /api/galaxy/import`.

### Fixed
- **Skill pack ships in the npm tarball.** `copy-static.mjs` now bundles
  `packages/skills` into `dist/skills`, and `packagedSkillsDir()` resolves it —
  global installs previously got an empty asteroid belt despite the docs.
- **`/api/health` reports the real version** (was a hardcoded `1.0.0`).
- **`schedules` / `goals` command wiring** matched their handler signatures,
  restoring a clean `tsc` (the publish workflow's typecheck gate).
- **`solix demo` no longer crashes on headless machines** — a missing browser
  opener emitted an unhandled async `spawn` error after seeding.
- **Right-side panels clear the TopBar** and the **Decision Queue sits beside
  an open panel** instead of overlapping it.

## [1.8.0] — 2026-05-24

**Security hardening — enforcing approvals, opt-in sandbox, and local-API auth.**

Until now Solix was an *observational* oversight layer: hooks were
fire-and-forget, so clicking **Deny** updated the UI but never actually stopped
the tool. This release makes approvals able to truly block — opt-in, and
fail-open by default so a Solix outage never wedges an agent. All three features
below are additive and off (or transparent) unless you turn them on.

### Added
- **Enforcing approval gate** (opt-in via `SOLIX_GATE_ENABLED=1`). The sensitive
  PreToolUse hooks (Bash, file writes, Task) become a **synchronous gate**: they
  POST to the new blocking `/events/permission` endpoint and wait until you
  Approve/Deny in the browser, then return Claude Code a real
  `permissionDecision`. **Deny** now blocks the tool; **Approve** releases it.
  Configurable fail policy via `SOLIX_GATE_POLICY` (`fail-open` default /
  `fail-closed`), `SOLIX_GATE_TIMEOUT` (hook, default 305s), and
  `SOLIX_GATE_TIMEOUT_MS` (server, default 300000).
- **Opt-in sandbox for Solix-launched agents.** `SOLIX_ENV_SCRUB=1` passes only
  an allowlisted environment (plus `ANTHROPIC_*` / `CLAUDE_*` and an opt-in
  `SOLIX_ENV_PASSTHROUGH`) so unrelated host secrets don't leak into agent
  subprocesses; `SOLIX_SANDBOX_CMD` wraps the spawned `claude` with a
  user-supplied jail (e.g. `bwrap …`, `sandbox-exec …`). Unset → no change.
- **Local-API authentication.** `solix install` writes a per-machine secret to
  `~/.solix/token` (mode 0600); hooks send it as `X-Solix-Token` and the server
  requires it on the spoofable `/events` ingestion surface. CORS is now
  restricted to known localhost origins (was wide open).
- **`SECURITY.md`** documenting the trust model and every env var, and a
  runnable **zero-to-one demo** (`scripts/demo-zero-to-one.sh`,
  `pnpm demo:zero-to-one`) with the `ZERO-TO-ONE.md` checklist.

### Changed
- `router` gains `requestPermission()` (the blocking gate path) while
  `resolvePermission()` now releases held gate requests; the observational
  `Notification` path is unchanged, so both coexist.
- Installs that predate the token simply run without enforcement until you
  re-run `solix install`.

## [1.7.0] — 2026-05-21

**Sprint N — Crew roster: discover & enable opt-in advisors, plus four new advisor types.**

The five opt-in advisors that shipped disabled were invisible and unreachable
from the UI — the only way to turn one on was the CLI. This release surfaces
them and grows the lineup to **14**.

### Added
- **Ghost planets** — opt-in (disabled) advisors now render as dim, pulsing
  planets on a faint outer ring. Click one to open its panel and press
  **＋ Add to crew** to enable it; it moves into the live inner ring (and the
  `+ Task` picker) without a reload.
- **Crew roster panel** — a new panel (TopBar **✦ Crew** button or press **C**)
  listing every advisor grouped **Active crew** vs **Available (opt-in)**, each
  with one-click Enable / Disable / Pin / Details. Header shows
  `N active · M available`.
- **Four new advisor types** (all opt-in, auto-seeded on next `solix start`):
  - **Cinder** ⚑ — Debugger / Incident (sonnet): triages failures from stack
    traces, logs, and failing tests.
  - **Delta** ⛁ — Data / DB Engineer (sonnet): schema, migrations, queries,
    data integrity.
  - **Spire** △ — Architect (opus): system design and trade-offs, distinct
    from Forge who builds.
  - **Ledger** ₵ — FinOps / Cost (haiku): watches spend against per-session
    budgets and suggests cheaper models.

### Changed
- New `set_advisor_enabled` WebSocket message routes through the server router,
  which broadcasts `advisor_upsert` live. Enabling/disabling from the UI updates
  instantly, and `solix advisors enable <id>` now also pushes the change to open
  browsers.
- README advisor table expanded to 14 rows; `CLI.md` and `OPERATING.md` document
  UI-based discovery of opt-in advisors.

### Fixed
- Restored the correct Compass glyph (`⌖` U+2316) in the advisor manifest.

## [1.6.0] — 2026-05-21

**Sprint M — Cost rings, Heartbeats, and Goal constellations.**

Three additive systems for running agents at scale: spend visibility, scheduled
tasks, and goal grouping.

### Added
- **Cost rings & budgets** — per-session spend is estimated live from the token
  usage Claude reports (model pricing × tokens) and drawn as a budget ring that
  fills sky → amber → red as it approaches the cap. Set a per-task **Budget
  (USD)** in the `+ Task` modal; a breach raises a card in the Decision Queue
  (**Raise cap** / **Dismiss**) and soft-pauses Solix-launched sessions. Costs
  are estimates, not billing figures.
- **Heartbeats** — recurring scheduled tasks via `solix schedule`
  (`add` / `list` / `enable` / `disable` / `remove`) on a `30m` / `2h` / `1d`
  cadence. Each enabled schedule renders as a pulsing node and launches a normal
  session when due (server checks every ~30s).
- **Goal constellations** — named objectives via `solix goal`
  (`add` / `list` / `remove`). Pick a goal in the `+ Task` modal (or create one
  inline); planets working toward the same goal are linked by constellation
  lines in the goal's color, and the SidePanel shows a goal chip.

### Changed
- New `@solix/shared` pricing module (`MODEL_PRICING`, `costForUsage`,
  `totalTokens`).
- New WebSocket messages (`cost_update`, `budget_alert`, `schedule_*`,
  `goal_*`), client messages (`raise_budget`, `dismiss_budget_alert`), and
  `launch_session` fields (`budgetUsd`, `goalId`).
- New SQLite columns (`cost_usd`, `budget_usd`, `current_goal_id`,
  `missions.goal_id`, `scheduled_tasks.cwd/name`) and a `goals` table, all via
  idempotent migrations.

## [1.5.0] and earlier

- **1.5.0** — Agent View bridge: auto-syncs with Claude Code 2.1.139+ background
  sessions; tasks launched from Solix round-trip into `claude agents`.

For releases before this changelog was introduced, see the
[Git history](https://github.com/shmulikdav/Solix/commits/main) and
[GitHub releases](https://github.com/shmulikdav/Solix/releases).

[1.11.3]: https://github.com/shmulikdav/Solix/releases/tag/v1.11.3
[1.11.2]: https://github.com/shmulikdav/Solix/releases/tag/v1.11.2
[1.11.1]: https://github.com/shmulikdav/Solix/releases/tag/v1.11.1
[1.11.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.11.0
[1.10.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.10.0
[1.9.3]: https://github.com/shmulikdav/Solix/releases/tag/v1.9.3
[1.9.2]: https://github.com/shmulikdav/Solix/releases/tag/v1.9.2
[1.9.1]: https://github.com/shmulikdav/Solix/releases/tag/v1.9.1
[1.9.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.9.0
[1.8.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.8.0
[1.7.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.7.0
[1.6.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.6.0
