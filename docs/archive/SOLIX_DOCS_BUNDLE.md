# Solix — combined documentation bundle

A single-file digest of the four planning + operating + reference docs
produced during the V1 build:

1. **PM Review** — the use-case-driven critique that drove Sprints F+G
2. **OPERATING.md** — task-oriented "how do I do X?" recipes
3. **CLI.md** — exhaustive reference for every `solix` sub-command
4. **System Test Plan** — 17-module end-to-end verification checklist

Each section below is the full content of the corresponding doc. The
sections are intentionally redundant in places — each one stands alone
so you can excerpt one without losing context. If you only have time
for one section, read **OPERATING.md** (Section 2).

> Generated from the docs at the repo root. The canonical source is
> always the individual `.md` files; this bundle is a convenience.

---
---

# Section 1 — PM Review (running Solix as a real user)

## Context

Sprint A–E are shipped. The user asked me to step into a PM hat,
role-play the target user, run a real use case end-to-end, and report
what works vs. what needs to change. This file is the deliverable — a
PM critique grounded in the actual UI strings, flows, and demo data of
the current build, plus a prioritized fix list ready to convert into
the next sprint.

## The use case I ran

**Persona**: Maya, a Series-A product manager. Three engineers are
using Claude Code in parallel — one refactoring orbital math, one
wiring a UI panel, one shipping a deploy. She wants to (a) know who's
stuck, (b) review/approve any sensitive operations, (c) hand work to
the right specialist, and (d) end the day with a clean audit trail of
what was decided.

I drove the demo build (`solix demo`) the way Maya would, in this
order:

1. Opened `localhost:4242`. Welcome modal greeted me.
2. Clicked "Got it", landed in galaxy view with the 3 demo planets.
3. Saw the red pulse on demo-c → opened DecisionQueue → saw the `git
   push origin main` permission with the amber "Pushing to main/prod"
   hint.
4. Clicked **Ask** to see the diff — got a chat tab that *only streams
   the transcript*. No diff. Switched to terminal. ❌
5. Approved the push from the queue (`Y`). Approval recorded.
6. Switched to **List** view — saw demo-b at 87% context, health bar
   amber. Tooltip: ¯\\_(ツ)_/¯ no explanation of what "health" means.
7. Switched to **Mission** view — clean. Could see what each agent
   actually did. This was the most "PM-shaped" surface in the app.
8. Opened **Galaxy panel → Versions** to compare yesterday vs. today's
   advisor lineup. Two-click diff worked.
9. Opened **Audit** tab — the approve from step 5 was there. ✅
10. Clicked "**+ Task**" to launch a new agent on a fourth project.
    The modal was clear, but I had no way to assign it to *Argus*
    (reviewer) even though Argus is pinned in the inner ring.

Total time-to-value: ~90 seconds. The metaphor sells itself.

## What's working (keep these)

1. **Galaxy → List → Mission three-lens model.** Each lens answers a
   different real question. List for "where is everyone?", Mission
   for "what got done?", Galaxy for "what's happening *right now*?"
   The `V`/`M` shortcuts make it cheap to flip.
2. **Decision Queue is a genuinely new primitive.** The combination
   of queue + suggestion + Y/N hotkey turns approvals from "alt-tab
   to terminal" into "glance and resolve." This is the killer move.
3. **Audit tab + Versions tab in one panel.** Compliance +
   change-history coexist where you'd expect them. Galaxy export →
   snapshot → diff is the right loop.
4. **Demo seeder actually triggers a permission.** Most demos are
   static; this one lets a new user *resolve* a real pending
   decision in 30 seconds. Strong onboarding asset.
5. **Heuristic suggestions punch above their weight.** Even a
   half-dozen regex rules (force-push, push to main, `.env` edits,
   context ≥90%) cover most "should I worry?" cases without LLM
   cost.
6. **Mission View grouping by project.** Cleaner than List for a PM
   — reads like a release log.

## What needs improvement (prioritized)

### P0 — these block the use case

- **P0-1. "Ask" button is a dead-end for external sessions.** The
  Decision Queue's "Ask" opens SidePanel → Chat → which says
  "External session — keep typing in your terminal." The user came
  from "I want to see the diff before I approve" and got a read-only
  transcript. Fix: either (a) replace "Ask" with "Show diff" that
  actually surfaces the args and any file targets, or (b) for `git
  push` / `Edit` permissions, inline a diff preview in the
  DecisionCard itself.
- **P0-2. No way to route a new task to a specific advisor.**
  "+Task" spawns a generic Claude session. The user can't say "have
  Argus review PR #42" from the UI, even though Argus is pinned. The
  advisor crew is the product's biggest differentiator and it's not
  reachable from the launcher. Fix: add an optional advisor selector
  to NewTaskModal; if set, prepend the advisor's system prompt.
- **P0-3. Health score is shown without explanation.** The bar is
  visible in List view and the halo intensity in Galaxy, but there's
  no tooltip or breakdown. Fix: hover tooltip with `reasons[]` from
  `computeHealth` (it's already returned, just not rendered).

### P1 — friction worth fixing this sprint

- **P1-1. Welcome modal is unreachable after dismiss.** No Help
  button in TopBar. Fix: add `?` key + a `(?)` icon that re-opens
  Welcome.
- **P1-2. Jargon without glossary.** "Compass / Forge / Lumen /
  Argus / Sentinel" is poetry, not function. Fix: subtitle each in
  Welcome and on hover ("Compass — your PM advisor"). Keep the
  names.
- **P1-3. Galaxy import has no confirmation.** A pasted manifest can
  silently flip 5 advisors on/off. Fix: show the diff *before*
  applying, using the `diffManifests()` helper we already shipped in
  Sprint E. Reuses existing code — almost free.
- **P1-4. Scene controls are invisible to new users.** Pan/zoom is
  keyboard-only with no on-screen affordance. Either (a) add a tiny
  "drag to pan · scroll to zoom" hint that fades after first
  interaction, or (b) accept that and document it in Welcome.
- **P1-5. NewTaskModal doesn't validate `claude` is on PATH.** A new
  user clicks Launch, nothing happens, no error. Fix: server-side
  preflight check; surface a single inline error.

### P2 — polish

- **P2-1. Decision Queue empty state takes real estate.** "All
  clear. Nothing waiting." could collapse to a one-line strip when
  idle.
- **P2-2. List view is missing an "advisor" column.** When advisors
  are invoked, you can't see which advisor ran which mission without
  drilling in.
- **P2-3. Mission View is missing an error column.** Failed missions
  show a red badge but no error summary.
- **P2-4. "subagent" and "awaiting_input" vs "awaiting_permission"
  are unexplained.** Add one-line tooltips.
- **P2-5. Demo doesn't exercise an advisor invocation.** Add a
  fourth scripted event: Compass invoked on demo-a after 5s, so
  first-time users see an advisor planet appear in the inner ring
  with a real mission attached.

## Sprint F shortlist (the four highest-leverage fixes)

1. **P0-1 inline diff in DecisionCard** — the single biggest UX
   unlock. For Bash-`git`, parse the command and show `git diff
   --stat` output; for Edit/Write, show the proposed patch. Server
   already has the args, no new permissions needed.
2. **P0-2 advisor selector in NewTaskModal** — a single dropdown +
   prompt prefix. Makes the advisor crew actually usable from the
   UI.
3. **P0-3 health-score tooltip** — render `reasons[]` on hover. ~30
   lines.
4. **P1-3 import confirmation diff** — reuse `diffManifests()`.
   Closes the "data loss risk" hole and showcases an existing
   primitive.

That's a tight, demo-able sprint. Each item is self-contained, none
require new infrastructure, and together they answer the three
questions Maya couldn't answer cleanly today: *"what am I
approving?", "who should do this?", "why is this score low?"*

> **Status (post-Sprint G):** All P0-* + P1-1, P1-2, P1-3, P1-4,
> P1-5, P2-1 are now shipped. Remaining P2-2, P2-3, P2-4, P2-5
> deferred to a future Sprint H.

## Out of scope (deliberate)

- Bi-directional chat for external sessions (would require a proxy
  protocol on top of Claude Code's transcript files — V2
  territory).
- Cloud registry for galaxy sharing (#12 Multi-User in PRD §17).
- LLM-powered predictive suggestions (#8 — heuristic path remains
  the call until we measure value).

---
---

# Section 2 — OPERATING.md (task-oriented recipes)

A practical, **task-oriented** companion to `CLI.md`. Where `CLI.md`
documents every flag of every sub-command, this guide answers *"what
do I type to accomplish X?"* — in the order you'd type it.

Each recipe is self-contained. Skim the headings, find your goal,
copy the commands. Most recipes assume you've done the one-time setup
once.

> **Cheat sheet (memorize these three)**
>
> ```
> solix install     # one-time, wires Claude Code hooks
> solix start       # boot the server (default port 4242)
> solix demo        # seed fake planets in another terminal
> ```

## One-time setup

```sh
# 1. Install the binary on PATH
npm i -g @shmulikdav/solix              # if published
# or, in a monorepo checkout:
pnpm install && pnpm -r build
# alias solix='node /path/to/Solix/packages/cli/dist/index.js'

# 2. Verify
which solix
solix --version

# 3. Wire the Claude Code hooks
solix install

# 4. Quick health check
solix doctor
```

## Daily start / stop

```sh
solix start                  # opens browser
solix start --no-open        # no browser
solix start --port 5000      # custom port
# Ctrl+C to stop. State persists in ~/.solix/solix.db.
```

## Recipes

### 1. See the thing without installing Claude Code

```sh
solix start            # T1
solix demo             # T2
```

Press `Y` to approve the demo's pending permission, `N` to deny. Reset
with `rm ~/.solix/solix.db && solix start`.

### 2. Run Claude and have it appear automatically

```sh
solix start                  # T1
cd ~/projects/my-app && claude   # T2 — planet appears in UI
```

If nothing appears: `solix doctor` flags missing hooks.

### 3. Approve / deny without alt-tabbing

UI-driven; no CLI command needed. Shortcuts: `Y` approve top, `N`
deny top, click `Ask` to open chat. Audit dump: `curl
http://127.0.0.1:4242/api/audit`.

### 4. Run a specialist (advisor) on a task

UI: `+ Task` → pick advisor chip → prompt. CLI:
```sh
solix advisors pin argus     # always-on Argus planet
solix advisors unpin argus   # stop it
```

### 5. Enable an opt-in advisor

```sh
solix advisors list
solix advisors enable mira   # appears in chips + inner ring
solix advisors pin mira      # also always-on (optional)
```

### 6. Install a Claude Code skill into a project

```sh
solix skills list
solix skills install file-utilities --project <projectId>
```
Find project IDs:
`sqlite3 ~/.solix/solix.db "SELECT id, cwd FROM projects"`.

### 7. Save and share config

```sh
# Source machine
solix galaxy export ~/team.galaxy.json --name "Backend Team" \
  --author "$(git config user.name)" \
  --description "Argus pinned, security skills installed"

# Receiving machine
solix galaxy import ~/team.galaxy.json
solix advisors pin argus    # imports never auto-pin
```

Imports change config flags only. They never auto-pin, auto-install
skills, or run shell commands.

### 8. Compare two galaxy snapshots

UI: Galaxy panel → Versions tab → click two versions → diff renders.
CLI:

```sh
solix galaxy export /tmp/v1.galaxy.json --name "before"
solix advisors pin argus
solix galaxy export /tmp/v2.galaxy.json --name "after"
diff <(jq -S . /tmp/v1.galaxy.json) <(jq -S . /tmp/v2.galaxy.json)
```

### 9. Develop UI without burning tokens

```sh
SOLIX_FAKE_CLAUDE=1 solix start
solix demo
```

Launcher emits synthetic transcript content instead of spawning
`claude`.

### 10. Run two Solix instances side by side

```sh
solix start                                            # A on 4242
SOLIX_DB_PATH=~/.solix/test.db solix start --port 5000 # B on 5000
solix demo --port 5000
```

### 11. Upgrade safely

```sh
git pull
pnpm -r build
solix install --force        # refresh hooks
solix doctor
solix start
```

DB preserved. Migrations applied on boot.

### 12. Solix isn't seeing my Claude sessions

```sh
solix doctor
```

| Doctor says | Fix |
|---|---|
| "Hooks not installed" | `solix install` |
| "Hook contents stale" | `solix install --force` |
| "Server not responding" | `solix start` |
| "Server on wrong port" | Match `SOLIX_PORT` |
| All ✓ but empty | Hard reload (cmd-shift-R) |

### 13. Remove Solix completely

```sh
solix uninstall
rm -rf ~/.solix
npm rm -g @shmulikdav/solix    # optional
```

Solix doesn't write anywhere else.

## Where the CLI ends and the UI begins

| CLI | UI equivalent |
|---|---|
| `solix advisors enable / disable / pin / unpin` | AdvisorPanel buttons |
| `solix skills install` | SkillPanel "Install" button |
| `solix galaxy export / import` | Galaxy panel → Sharing tab |
| `solix demo` | (CLI only) |
| `solix doctor` | (CLI only) |

## Glossary

- **Galaxy** — the rendered space; also a portable JSON manifest of
  your config.
- **Planet** — one Claude Code session.
- **Sun** — the Solix server itself (metaphor only).
- **Advisor** — long-lived specialist agent (Compass / Forge / Lumen
  / Argus / Sentinel + opt-ins) with its own AGENT.md.
- **Skill** — a folder with a `SKILL.md`, rendered as an asteroid.
- **Mission** — one user prompt's lifecycle (pending → active →
  completed/failed/cancelled).
- **Subagent** — a child agent of a session, rendered as an orbiting
  moon.
- **Pinned** — an advisor that's always running.
- **Decision Queue** — top-right inbox of pending permissions.
- **Audit log** — append-only history of approve/deny/invoke/pin/
  import events.

---
---

# Section 3 — CLI.md (full reference)

The `solix` command is your one entry point for installing hooks,
running the server, seeding demos, managing advisors and skills,
sharing galaxies, and diagnosing problems.

> **TL;DR**
>
> ```
> solix install       # one-time: wire Claude Code hooks
> solix start         # boot the server (default port 4242)
> solix demo          # seed fake planets to play with
> solix doctor        # diagnose if something's off
> ```

## How `solix` is invoked

| Context | Command |
|---|---|
| Globally installed | `solix <cmd>` |
| Monorepo checkout | `node packages/cli/dist/index.js <cmd>` |
| pnpm workspace | `pnpm --filter @shmulikdav/solix exec solix <cmd>` |

## `solix install`

Wires Solix's hook scripts into `~/.claude/settings.json`.

| Flag | Effect |
|---|---|
| `--force` | Overwrite existing Solix hooks. Use after upgrading. |

What it does:
1. Backs up `~/.claude/settings.json` to `settings.json.solix.bak.<ts>`.
2. Adds Solix's pre-tool / post-tool / session-start / session-end
   hooks.
3. Each hook is a one-line `curl` to `/events` with `--max-time 1`
   and `exit 0` (fail-open).

## `solix start`

Boots HTTP + WebSocket + static UI on one port.

| Flag | Default | Effect |
|---|---|---|
| `-p, --port <port>` | `4242` | Port to listen on |
| `--no-open` | (open) | Don't auto-open browser |

Output:
```
[solix] server listening on http://127.0.0.1:4242
[solix] events  -> POST http://127.0.0.1:4242/events
[solix] ws      -> ws://127.0.0.1:4242/ws
```

`Ctrl+C` stops. State persists to `~/.solix/solix.db` (WAL). `solix`
alone is equivalent to `solix start`.

## `solix demo`

Seeds the running server with synthetic planets, missions, a
permission, and a pinned advisor.

| Flag | Default |
|---|---|
| `-p, --port <port>` | `4242` |

Demo state:
- **demo-a** — opus, 62% context, active.
- **demo-b** — sonnet, 87% context, active, has subagent moon.
- **demo-c** — haiku, idle, awaiting `git push origin main`
  permission (red pulse).
- **Compass** — pinned advisor.

## `solix advisors`

```
solix advisors list                # default
solix advisors enable <id>         # add to inner ring
solix advisors disable <id>        # remove from ring
solix advisors pin <id>            # spawn always-on planet
solix advisors unpin <id>          # stop the always-on process
```

`enable` does NOT spawn a process; `pin` does.

## `solix skills`

```
solix skills list                              # default
solix skills install <id> --project <id>       # mark as installed
```

Skills auto-discovered from `~/.claude/skills` and
`packages/skills`. Install just records intent in the DB.

## `solix galaxy`

```
solix galaxy export <out> [--name --author --description]
solix galaxy import <fileOrUrl>
solix galaxy publish <slug> [--name --author --description]
solix galaxy install <slug>                   # from registry
```

**Export side effect:** snapshots a `galaxy_versions` row (deduped on
byte-identical re-exports).

**Import never:** auto-pins, auto-installs skills, or runs shell
commands. Configuration flags only.

`publish` / `install` require a configured registry.

## `solix doctor`

One-shot health check. Prints ✓/✗ for:
- `~/.claude/settings.json` exists + has Solix hooks
- DB readable
- `packages/agents/manifest.json` valid
- Server alive on `SOLIX_PORT` (calls `/api/health`)
- `claude` on PATH (optional)

## `solix uninstall`

Restores `~/.claude/settings.json` from the latest
`.solix.bak.<ts>`. Does NOT touch `~/.solix/solix.db`.

To wipe everything: `rm -rf ~/.solix/`.

## Environment variables

| Var | Effect |
|---|---|
| `SOLIX_PORT` | Default port for `start` and `doctor`. |
| `SOLIX_FAKE_CLAUDE=1` | Don't actually spawn `claude`; emit synthetic transcripts. |
| `SOLIX_DB_PATH` | Override SQLite path (default `~/.solix/solix.db`). |
| `PATH` | Must include `claude` for live launching. |

## Common workflows (recap)

A. **First-time setup**: `npm i -g @shmulikdav/solix`, `solix
   install`, `solix start`, optional `solix demo`.

B. **Daily use**: just `solix start` and run `claude` as usual.

C. **Demo for teammate**: `solix start &` + `solix demo`.

D. **Save and replay team config**: `solix galaxy export` →
   `solix galaxy import` (then explicit `pin`).

E. **UI-only dev**: `SOLIX_FAKE_CLAUDE=1 solix start`.

F. **Inspect DB**: `sqlite3 ~/.solix/solix.db`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `EADDRINUSE` on start | Kill the other process or `--port 5000` |
| Browser shows OFFLINE | `solix doctor`; check port |
| `claude` runs but no planet | `solix install --force` |
| "claude not found" warning | Restart server from a shell with `claude` on PATH |
| `solix demo` network error | Server not running or wrong port |
| Import didn't pin advisors | By design — `solix advisors pin <id>` explicitly |
| Versions tab keeps growing | Identical re-exports are deduped server-side |
| UI shows old layout | Hard reload (cmd-shift-R) |
| Hooks dropping events | Hooks are fail-open; restart server |

---
---

# Section 4 — End-to-end system test plan

## Context

Solix is a local-first command center for Claude Code agents. Seven
sprints (A–G) of feature work shipped without a single end-to-end run
by a human in a browser. This document is a structured test plan
covering every user-visible surface of the system, intended to be
walked top-to-bottom by a single tester to validate the whole product
before declaring V1 ready.

## How to use

- Each test case has an **ID**, **prerequisite**, **steps**, and an
  **expected result**. Mark `[PASS]`, `[FAIL]`, or `[N/A]`.
- Severity legend:
  - **S1 blocker** — server won't boot, queue doesn't show pending.
  - **S2 major** — feature works but workflow broken.
  - **S3 minor** — visual or copy issue.
- Whole plan walks in ~45 minutes on a working machine.

## Pre-flight environment

| Item | Required |
|---|---|
| Node | ≥ 20.x |
| pnpm | ≥ 8.x |
| Browser | Chrome/Edge/Firefox latest |
| OS | macOS / Linux |
| `claude` CLI | Optional (live launching only) |

```sh
git clone <repo> && cd Solix
pnpm install
pnpm -r build
# T1: node packages/server/dist/cli.js start
# T2: node packages/server/dist/cli.js demo
```

Open `http://127.0.0.1:4242`.

## Module 1 — Setup & smoke

- **TC-1.1** Fresh boot — server prints listening URL, no traces.
- **TC-1.2** UI loads — TopBar + green CONNECTED, no console errors.
- **TC-1.3** Empty galaxy — Welcome modal + EmptyHint visible.
- **TC-1.4** Welcome content — Step 3 lists each enabled advisor
  (glyph + codename + name).
- **TC-1.5** Demo seeder — 3 demo planets, Compass advisor, Welcome
  auto-dismisses, attention=1.
- **TC-1.6** Server logs clean.

## Module 2 — Hooks & telemetry

- **TC-2.1** Hook scripts use `--max-time 1` + `exit 0`.
- **TC-2.2** Real `claude` session creates a planet within 1–2s.
- **TC-2.3** JSONL transcript streams in SidePanel Chat tab.
- **TC-2.4** Server stop/restart → UI flips OFFLINE→CONNECTED, state
  re-populates.

## Module 3 — Galaxy view (3D scene)

- **TC-3.1** Default view shows sun + Compass + 3 demo planets.
- **TC-3.2** Color encoding: opus=purple, sonnet=blue, haiku=gold;
  advisors use their own color.
- **TC-3.3** Pulse: demo-c (awaiting permission) pulses red.
- **TC-3.4** Size: planets scale with context % (87% > 62%).
- **TC-3.5** Atmosphere rim glows brighter for healthier planets.
- **TC-3.6** Hover label: name / model · status / `♥ health N · {top
  reason}`.
- **TC-3.7** Click planet → SidePanel; other planets dim.
- **TC-3.8** Esc / click empty → SidePanel closes; dim resets.
- **TC-3.9** Space pauses orbit; ▶/⏸ button toggles.
- **TC-3.10** Mouse-wheel zoom + drag pan + `0` reset + arrows.
- **TC-3.11** Scene-hint chip shows once, dismisses on ✕, persists.

## Module 4 — List view

- **TC-4.1** `V` (or click ☰ List) → tabular view.
- **TC-4.2** Project grouping correct.
- **TC-4.3** Columns: ● | Agent | Status | Health | Mission · tools |
  Context | Last activity. Click-to-sort.
- **TC-4.4** Needs-attention: red tint + pulsing red ●.
- **TC-4.5** Health bar hover → popover with `Health N/100` + bullet
  list of reasons.
- **TC-4.6** Sort indicator ▲/▼ follows.
- **TC-4.7** Row click → SidePanel.
- **TC-4.8** Empty state copy correct.

## Module 5 — Mission view

- **TC-5.1** `M` (or ◎ Missions) → mission cards grouped by project.
- **TC-5.2** Card content: shortName, status badge, prompt clamped,
  agent attribution, counts, file chips, time/duration.
- **TC-5.3** Status filter chips work (all/active/completed/failed/
  cancelled).
- **TC-5.4** Click card → SidePanel for that session.
- **TC-5.5** Empty state copy correct.

## Module 6 — Decision Queue

- **TC-6.1** demo-c permission visible on load.
- **TC-6.2** Inline `will run` preview shows full command in
  monospace (P0-1).
- **TC-6.3** Amber suggestion line "Pushing to main…".
- **TC-6.4** Approve button → card disappears + queue collapses to
  `decisions 0 — all clear` pill (P2-1).
- **TC-6.5** `Y` approve via keyboard.
- **TC-6.6** `N` deny via keyboard; audit recorded.
- **TC-6.7** Ask button opens SidePanel for that session.
- **TC-6.8** Multiple pending stack newest-first.
- **TC-6.9** Pill ⇄ full layout transition is seamless.
- **TC-6.10** Edit-tool preview: file path + `-` red old + `+` green
  new + expand button if long.

## Module 7 — SidePanel

- **TC-7.1** Right sidebar 460px, 3 tabs (Chat/Missions/Files), ✕
  closes.
- **TC-7.2** Header: `name · model · status · {internal|external}` +
  context meter.
- **TC-7.3** Suggestion bar shows for ≥80% context sessions.
- **TC-7.4** External chat: read-only with terminal hint footer.
- **TC-7.5** Empty chat copy correct.
- **TC-7.6** Missions tab newest-first with metrics.
- **TC-7.7** Files tab deduplicated and sorted.
- **TC-7.8** Internal session shows composer + Send (Cmd+Enter).

## Module 8 — Advisors

- **TC-8.1** Inner ring shows pinned advisors only.
- **TC-8.2** Click → AdvisorPanel with role + AGENT.md preview.
- **TC-8.3** Pin a non-pinned advisor → planet appears + toast.
- **TC-8.4** Audit row: `advisor pinned · Pinned X in {cwd}`.
- **TC-8.5** Unpin → planet vanishes; audit recorded.
- **TC-8.6** Invoke advisor → toast `Invoke X → Y · N missions`.

## Module 9 — Skills

- **TC-9.1** Asteroid belt renders.
- **TC-9.2** Hover shows skill id.
- **TC-9.3** Click → SkillPanel with SKILL.md + source badge.
- **TC-9.4** Install button records intent.

## Module 10 — New Task / launcher

- **TC-10.1** `L` opens modal; project quick-buttons populate.
- **TC-10.2** Preflight green: `claude detected · 1.x.y` (P1-5).
- **TC-10.3** Preflight red: red banner + Launch disabled (P1-5).
- **TC-10.4** Validation disables Launch on empty cwd or prompt.
- **TC-10.5** Advisor chip row: `none` + one chip per enabled
  advisor (P0-2).
- **TC-10.6** Launch with Argus → Chat shows `[Acting as Argus —
  Reviewer Argus. ...]` prefix.
- **TC-10.7** Default model adopts advisor's `defaultModel`.
- **TC-10.8** Cancel/Esc closes modal cleanly.

## Module 11 — Galaxy panel: Sharing / Versions / Audit

- **TC-11.1** `G` opens panel; 3 tabs.
- **TC-11.2** Header counts match store.
- **TC-11.3** Export downloads `.galaxy.json`.
- **TC-11.4** Export creates Versions row.
- **TC-11.5** Identical re-export deduped.
- **TC-11.6** Two-click diff: from→to highlighting + structured
  diff.
- **TC-11.7** Clear selection clears diff.
- **TC-11.8** Apply manifest shows amber confirm panel with diff
  (P1-3).
- **TC-11.9** Cancel pending import — no changes applied.
- **TC-11.10** Confirm → result line + advisors toggled.
- **TC-11.11** URL import shows confirm without diff (server-side
  fetch).
- **TC-11.12** Bad JSON shows `Could not parse JSON.`
- **TC-11.13** `?preview=1` doesn't snapshot.

## Module 12 — Audit log

- **TC-12.1** Audit tab loads with kind/timestamp/summary rows.
- **TC-12.2** Filter chips narrow list.
- **TC-12.3** New events propagate on tab refresh.
- **TC-12.4** Color coding: approved=green, denied=red,
  imported=cyan, advisor_*=amber.
- **TC-12.5** Empty state copy correct.

## Module 13 — Timeline playback

- **TC-13.1** `T` opens drawer with scrubber.
- **TC-13.2** Drag back → TopBar shows `▸ PLAYBACK` badge.
- **TC-13.3** Play advances; states animate.
- **TC-13.4** Close drawer → badge disappears, returns to now.
- **TC-13.5** Empty timeline shows hint, not blank.

## Module 14 — Welcome / help / preflight

- **TC-14.1** First load shows Welcome (TC-1.3).
- **TC-14.2** Auto-dismiss when sessionCount > 0.
- **TC-14.3** `?` re-opens regardless of dismiss flag (P1-1).
- **TC-14.4** TopBar `(?)` button re-opens.
- **TC-14.5** Esc closes.
- **TC-14.6** "Got it" persists dismiss in localStorage.
- **TC-14.7** "Open Galaxy panel" opens panel + closes Welcome.

## Module 15 — Persistence & resilience

- **TC-15.1** ViewMode persists across reload.
- **TC-15.2** Motion preference persists.
- **TC-15.3** Welcome dismiss persists.
- **TC-15.4** Server restart while UI open → re-populates.
- **TC-15.5** DB persists actions across restart.
- **TC-15.6** WebSocket auto-reconnects on network blip.

## Module 16 — Keyboard shortcuts

| Key | Effect |
|---|---|
| `?` | Welcome toggles |
| `G` | Galaxy panel toggles |
| `L` | New Task modal opens |
| `T` | Timeline drawer toggles |
| `V` | Cycles galaxy → list → missions → galaxy |
| `M` | Jumps to missions view |
| `Space` | Play/pause orbital motion |
| `Y` | Approve top pending |
| `N` | Deny top pending |
| `Esc` | Closes panels / modals / clears selection |
| `+` `-` `0` | Zoom in / out / reset |
| Arrows | Pan camera |

- **TC-16.13** Shortcuts ignored when textareas/inputs focused.

## Module 17 — Regression / non-functional

- **TC-17.1** No console errors across the walkthrough.
- **TC-17.2** Bundle size ~1.1 MB raw / ~315 KB gzip.
- **TC-17.3** Memory stable after 10 min idle.
- **TC-17.4** Multi-window stays in sync via WebSocket.
- **TC-17.5** Offline shows "Waiting for the Solix server…".
- **TC-17.6** ~30 sessions: galaxy renders (FPS may drop), list
  smooth.

## Reporting template

```
TC ID: TC-X.Y
Severity: [S1 / S2 / S3]
What I saw: <one sentence>
Expected: <one sentence>
Console: <yes / no, paste any error>
Repro: <consistent / intermittent>
Notes:
```

## Suggested next sprint based on outcome

- **All green** → Sprint H (advisor column in List, error column in
  Mission, terminology tooltips, demo seeds advisor invocation).
- **One or two S2 failures** → fix-forward; re-run failing modules.
- **An S1 failure** → stop, root-cause, hotfix branch.
- **Concept-level miss** → re-do PM review with fresh eyes.

## Out of scope

- Performance benchmarking (frame rate / memory profiling).
- Headless / CI automation (Playwright is its own effort).
- Multi-user / cross-machine galaxy sharing.
- Bi-directional chat for external sessions (V2).
- LLM-powered predictive suggestions (V2).

---

*End of bundle. Source files: `CLI.md`, `OPERATING.md`,
`/root/.claude/plans/i-want-to-plan-rustling-sphinx.md` (test plan).*
