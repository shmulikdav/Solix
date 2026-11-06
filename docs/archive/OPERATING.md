# Solix — operating guide

A practical, **task-oriented** companion to `CLI.md`. Where `CLI.md`
documents every flag of every sub-command, this guide answers *"what
do I type to accomplish X?"* — in the order you'd type it.

Each recipe is self-contained. Skim the headings, find your goal, copy
the commands. Most recipes assume you've done the [one-time setup](#one-time-setup)
once.

> **Cheat sheet (memorize these three)**
>
> ```
> solix install     # one-time, wires Claude Code hooks
> solix start       # boot the server (default port 4242)
> solix demo        # seed fake planets in another terminal
> ```

---

## One-time setup

Done once per machine.

```sh
# 1. Install the binary on PATH
npm i -g @shmulikdav/solix

# 2. Verify
which solix             # → /usr/local/bin/solix
solix --version         # → 1.0.0

# 3. Wire the Claude Code hooks
solix install

# 4. Quick health check
solix doctor
```

You should see ✓ marks for `~/.claude/settings.json`, the agent
manifest, and the DB. The server-running check will fail until you
boot it — that's expected.

> **From source instead?** Clone the repo, `pnpm install && pnpm -r
> build`, then either add `packages/cli/dist/index.js` to PATH or
> `alias solix='node /path/to/Solix/packages/cli/dist/index.js'`.

> **Native dep note:** Solix uses `better-sqlite3`. Most users get a
> prebuilt binary on `npm install`. If yours doesn't, npm compiles
> from source — needs `xcode-select --install` (macOS),
> `build-essential` (Linux), or VS Build Tools (Windows).

---

## Daily start / stop

Open a dedicated terminal tab, leave it running while you work.

```sh
# Start (opens browser tab automatically)
solix start

# Or no-browser:
solix start --no-open

# Or different port:
solix start --port 5000
```

`Ctrl+C` to stop. Solix persists state to `~/.solix/solix.db`, so
restarting picks up where you left off — sessions, missions, audit
log, galaxy versions, all preserved.

---

## Recipes

Numbered for easy reference; not meant to be executed top-to-bottom.

### 1. "I just want to see the thing without installing Claude Code"

```sh
# Terminal 1
solix start

# Terminal 2
solix demo
```

Open the browser tab. You'll see three demo planets, a pinned
advisor, and a pending permission. Press `Y` to approve it, `N` to
deny. You're now exercising the full UI without ever running
`claude`.

To clear the demo state, stop the server, delete the DB, restart:

```sh
rm ~/.solix/solix.db
solix start
```

---

### 2. "I want to run Claude and have it appear automatically"

You only need this once: `solix install`. After that, every `claude`
session anywhere on your machine reports to Solix automatically.

```sh
# Terminal 1 (always-on)
solix start

# Terminal 2 (anywhere)
cd ~/projects/my-app
claude
> Help me refactor this module.
```

A planet for that session appears in the UI within a second. Click
it to open the SidePanel.

If nothing appears: `solix doctor` will tell you whether hooks are
wired.

---

### 3. "I want to approve / deny a sensitive command without alt-tabbing"

When Claude Code is about to run a tool that needs permission, the
**Decision Queue** in the top right of the UI fills up. Each card
shows the actual command (or patch), a heuristic suggestion, and
three buttons.

You don't need a CLI command for this — it's UI-driven. But the
keyboard shortcuts are:

| Key | Effect |
|---|---|
| `Y` | Approve top pending permission |
| `N` | Deny top pending permission |
| (click "Ask") | Open chat for that session |

For richer audit, run `curl http://127.0.0.1:4242/api/audit` to dump
the audit trail as JSON.

---

### 4. "I want a specialist (advisor) to run a specific task"

Two ways: from the UI (NewTaskModal advisor chips) or by pinning
plus invoke.

**One-off task with an advisor identity (UI):**

1. Click `+ Task` in the TopBar (or press `L`).
2. Pick the project's working directory.
3. Click an advisor chip (e.g. `Argus` for Reviewer).
4. Type the prompt and hit `Cmd/Ctrl+Enter`.

**Always-on advisor (CLI):**

```sh
# Make Argus a permanent planet in the inner ring
solix advisors pin argus

# Confirm it's pinned
solix advisors list | grep argus
```

A long-lived `claude` process spawns with the Argus AGENT.md as its
identity. To stop it:

```sh
solix advisors unpin argus
```

---

### 5. "I want to enable an opt-in advisor I haven't used yet"

The crew ships with five default advisors enabled (Compass, Forge,
Lumen, Argus, Sentinel). Others (e.g. Mira, Echo) are opt-in.

```sh
# See everything
solix advisors list

# Enable one (now appears in NewTaskModal chips and inner ring slot)
solix advisors enable mira

# To disable later
solix advisors disable mira
```

`enable` does NOT spawn a process. To make Mira always-on, also run
`solix advisors pin mira`.

**From the UI (v1.7.0+):** you don't need the CLI to discover opt-in
advisors anymore. They render as dim **ghost planets** on a faint outer
ring — click one and press **＋ Add to crew**. Or press **C** (the
**✦ Crew** button) for the full roster: all 14 advisors grouped active vs
available, each with Enable / Disable / Pin. There are 9 opt-in advisors:
Mira (QA), Echo (Docs), Helios (Perf), Vale (Release), Atlas (Skills),
Cinder (Debugger), Delta (Data/DB), Spire (Architect), Ledger (FinOps).

---

### 6. "I want to install a Claude Code skill into a project"

Skills are auto-discovered from `~/.claude/skills` and
`packages/skills`. The CLI just records install intent in the DB.

```sh
# See available skills
solix skills list

# Mark a skill as installed for a specific project
solix skills install file-utilities --project <projectId>
```

Project IDs are visible in the UI's Galaxy panel header counts, or
via `sqlite3 ~/.solix/solix.db "SELECT id, cwd FROM projects"`.

---

### 7. "I want to save my Solix config and share it"

```sh
# 1. Snapshot to a JSON file
solix galaxy export ~/team.galaxy.json \
  --name "Backend Team" \
  --author "$(git config user.name)" \
  --description "Argus pinned, security skills installed"

# 2. Share the file (Slack, email, gist, whatever)

# On the receiving machine:
solix galaxy import ~/team.galaxy.json
```

**Important — what import does NOT do:**

- ❌ Auto-pin advisors. The receiver must run `solix advisors pin
  <id>` themselves.
- ❌ Install skills (filesystem changes are explicit).
- ❌ Run shell commands.

This is by design — imports change configuration flags only.

---

### 8. "I want to compare two snapshots of my galaxy"

The UI's Galaxy panel → Versions tab does this with a two-click
selection. Every `solix galaxy export` (or `/api/galaxy/export`)
creates a version row, and identical re-exports are deduped.

For a CLI-only comparison:

```sh
# Old:
solix galaxy export /tmp/v1.galaxy.json --name "before"

# Make some changes (pin/unpin, enable/disable):
solix advisors pin argus
solix advisors enable mira

# New:
solix galaxy export /tmp/v2.galaxy.json --name "after"

# Compare:
diff <(jq -S . /tmp/v1.galaxy.json) <(jq -S . /tmp/v2.galaxy.json)
```

For the structured diff (added/removed/pinChanged), use the UI.

---

### 9. "I want to develop the UI without burning Claude Code tokens"

```sh
SOLIX_FAKE_CLAUDE=1 solix start
```

In this mode, the launcher emits synthetic transcript content
instead of spawning real `claude` processes. The Decision Queue,
advisor invocation, mission lifecycle, etc. all work — just with
fake content. Combine with `solix demo` for a fully populated
playground.

---

### 10. "I want to run two Solix instances side by side"

```sh
# Instance A (default port 4242)
solix start

# Instance B (different port + different DB)
SOLIX_DB_PATH=~/.solix/test.db solix start --port 5000
solix demo --port 5000
```

Each instance has its own DB and UI. Useful for testing imports
across two configurations without nuking your main DB.

---

### 11. "I want to upgrade Solix safely"

```sh
# Pull or upgrade
git pull        # in a checkout
# or: npm i -g @shmulikdav/solix@latest

pnpm -r build   # if from source

# Refresh hooks (in case the hook script content changed)
solix install --force

# Run diagnostics
solix doctor

# Boot
solix start
```

Your DB is preserved across upgrades. If a migration is needed, the
server applies it on boot via `ensureColumn` / `CREATE TABLE IF NOT
EXISTS`.

---

### 12. "Solix isn't seeing my Claude sessions — what now?"

Run the diagnostics and walk the symptoms:

```sh
solix doctor
```

Common causes (paired with the troubleshooting table in `CLI.md`):

| Doctor says | Likely cause | Fix |
|---|---|---|
| "Hooks not installed" | First-time setup wasn't done | `solix install` |
| "Hook contents stale" | Upgraded CLI, didn't refresh | `solix install --force` |
| "Server not responding" | Forgot to start | `solix start` |
| "Server on wrong port" | Custom `SOLIX_PORT` mismatch | Match the server start to the doctor's port |
| All ✓ but still empty | Browser tab cached | Hard reload (cmd-shift-R) |

---

### 12.4. "I want my Solix planets to mirror `claude agents`"

Claude Code 2.1.139+ ships **Agent View** — a TUI for managing
background sessions, accessed with `claude agents`. Solix
automatically mirrors every Agent View session as a planet, no
configuration required.

```sh
# In one terminal
solix start

# In any other terminal
claude agents
# Dispatch a session — type a prompt and Enter.
# Within ~1 second, a planet for that session appears in Solix.
```

Conversely, when you launch a task from Solix's `+ Task` modal,
Solix dispatches it via `claude --bg` so it shows up in both Solix
and `claude agents`. Toggle this in the modal: the
`agent view: on/off` link under the version line. When off, Solix
falls back to the older `claude --print` path.

Each Agent View session in Solix gets:

- A small cyan `agent` chip in the List view and on the planet's
  hover label
- The Haiku-generated one-line summary Anthropic produces (refreshes
  ~every 15 s while working) — replaces the mission shortName in
  the Mission column
- A PR chip in the SidePanel header with CI status (✓/✗/⏳) when the
  session opens a pull request

Verify your local install supports Agent View with `solix doctor` —
look for the "Agent View available" check.

---

### 12.5. "I want to type prompts in the UI for sessions I started in my terminal"

By default Solix can only **read** what an externally-launched
`claude` session is doing — the chat tab in the SidePanel is
read-only. To enable bidirectional chat (UI → terminal), launch the
session under Solix's PTY wrapper instead of bare `claude`.

```sh
# Per-session: wrap explicitly
solix run                          # interactive REPL, just like claude
solix run -p "Refactor README"     # one-shot, like claude --print

# Permanent: alias claude → solix run via your shell rc
solix install-shim
exec $SHELL                        # reload, then `claude` is wrapped
```

In the UI, wrapped sessions show a small `wrapped` badge in the
SidePanel header. The chat composer is enabled — type a prompt,
Cmd/Ctrl+Enter, the text lands in your terminal as if you'd typed
it. claude responds normally and the response streams into Solix.

Mechanism: `solix run` spawns claude under a pseudo-terminal
(node-pty), opens a Unix socket at `~/.solix/wrappers/<id>.sock`,
and registers it with the Solix server. The server forwards UI
prompts to the socket; the wrapper writes them to claude's PTY
stdin.

**Limitation**: don't type in the terminal while the UI is sending a
prompt — characters interleave. Pick one channel per turn.

To remove: `solix uninstall` strips the shim block from your shell rc.

---

### 12.6. "I want to cap what an agent can spend" (v1.6.0+)

Open `+ Task` (press `L`), set a **Budget** in USD, and launch. Solix
estimates spend from the token usage Claude reports in the transcript and
draws a **budget ring** around the planet that fills amber → red as it
approaches the cap. When the cap is hit:

- a red **budget** card appears in the Decision Queue (top-right),
- for Solix-launched sessions, no further prompts are sent until you
  **Raise cap**,
- the SidePanel shows `$spent / $cap`.

Costs are estimates (model pricing × reported tokens), not billing-grade.
Externally-launched `claude` sessions are flagged but can't be force-stopped.

### 12.7. "I want a task to run on a schedule" (v1.6.0+)

```sh
solix schedule add "summarize new issues" --cwd ~/projects/app --every 1d --name "daily triage"
solix schedule list
```

Each enabled schedule shows as a pulsing node in the galaxy with its next
run time. When it fires (server checks every ~30 s) it launches a normal
session you can watch like any other. Cadence is `30m` / `2h` / `1d`.
Disable without deleting: `solix schedule disable <id>`.

### 12.8. "I want to group related agents under a goal" (v1.6.0+)

```sh
solix goal add "Ship v2"
```

Then pick that goal in the `+ Task` modal (or create one inline with **+
new**). Planets working toward the same goal are linked by constellation
lines in the goal's color, and each shows the goal chip in its SidePanel.
Removing a goal detaches it from its sessions/missions cleanly.

---

### 13. "Buttons in the Solix UI feel stuck — clicks don't register"

If clicking the view toggle (`🪐 Galaxy` / `≡ List` / `◎ Missions`) or
the timeline's `× Live` does nothing, the most common culprit isn't
Solix — it's a **third-party screen overlay app** intercepting clicks.
Common offenders on macOS:

- **Granola** ("Take notes for you?" pill at the top of the screen)
- **Loom**, **CleanShot X**, **Shottr** with auto-detected regions
- Some menu-bar AI assistants that float a recording dot

How to tell: hover the pill / overlay — if it's solid pixels in the
top portion of your screen, it's eating clicks even on parts that
look transparent.

Workarounds:

| Fix | When |
|---|---|
| **Use keyboard shortcuts** | Always works. `V` cycles views, `Esc` exits playback / closes panels, `T` toggles timeline, `?` re-opens help. |
| **Quit the overlay app** | Cmd+Q from its menu bar. Re-launch when done. |
| **Move Solix to a different monitor** | If the overlay is locked to one screen. |
| **Use the regular browser tab** | Instead of the installed PWA — sometimes overlays target standalone apps differently. |

V1.1.1+ also makes Solix's TopBar `z-40`, so panels and the timeline
no longer cover navigation. But OS-level overlays sit above
everything in the browser; only quitting them gets clicks back.

---

### 14. "I want to remove Solix completely"

```sh
solix uninstall   # restores ~/.claude/settings.json from backup
rm -rf ~/.solix   # delete DB + any cached state
# (optionally) npm rm -g @shmulikdav/solix
```

That's it. Solix doesn't write anywhere else on your machine.

---

## Where the CLI ends and the UI begins

The CLI is the **operations** layer (install, start, manage config,
share). The UI is the **interaction** layer (approve permissions,
read transcripts, invoke advisors, browse missions).

Most CLI commands have a UI equivalent so non-technical teammates
can drive everything from the browser:

| CLI | UI equivalent |
|---|---|
| `solix advisors enable / disable / pin / unpin` | AdvisorPanel buttons |
| `solix skills install` | SkillPanel "Install" button |
| `solix galaxy export / import` | Galaxy panel → Sharing tab |
| `solix demo` | (no UI equivalent — CLI only) |
| `solix doctor` | (no UI equivalent — CLI only) |

The CLI exists for: scriptability, headless setup, emergency
recovery, and parity for tasks that aren't worth a UI surface.

---

## Glossary (for newcomers)

- **Galaxy** — the whole space rendered in the UI. Also: a portable
  snapshot of your Solix configuration (the JSON manifest you
  export/import).
- **Planet** — one Claude Code session.
- **Sun** — the Solix server itself. Click-target metaphor; not a
  real entity.
- **Advisor** — a long-lived specialist agent (Compass / Forge /
  Lumen / Argus / Sentinel + opt-ins). Has its own AGENT.md.
- **Skill** — a folder with a `SKILL.md` describing capability.
  Rendered as an asteroid in the belt.
- **Mission** — one user prompt's lifecycle inside a session
  (pending → active → completed/failed/cancelled).
- **Subagent** — a child agent spawned by a parent session.
  Rendered as a moon orbiting the parent planet.
- **Pinned** — an advisor that's always running (own planet in the
  inner ring).
- **Decision Queue** — the top-right inbox of pending permissions.
- **Audit log** — append-only history of every approve/deny/invoke
  /pin/import event.

---

## See also

- `CLI.md` — exhaustive reference of every sub-command and flag
- `README.md` — architecture, metaphor, roadmap
- `DEMO.md` — non-technical first-look walkthrough
- `DEMO_PM.md` / `DEMO_DEV.md` — persona-specific walkthroughs
