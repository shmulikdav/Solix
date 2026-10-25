# Solix — end-to-end smoke test

**Version under test:** `________`  **Tester:** `________`  **Date:** `________`
**Platform:** macOS ☐ / Linux ☐ / WSL ☐  **Node:** `________`

---

## How to use this

Every case is independently runnable and states its own preconditions. Mark
each **PASS** / **FAIL** / **N/A** and write what you actually saw in Notes —
"didn't match" is more useful than an unticked box.

| Priority | Meaning |
|---|---|
| **P0 — BLOCKER** | A failure here means do not ship to testers. These are safety and data-integrity claims. |
| **P1** | Core promise of the product. A failure is a bad first impression. |
| **P2** | Should work; a failure is a bug to file, not a stop-ship. |

**Read this before you start — it determines what you are testing.**

Solix has two distinct modes, and the blocking approval gate only exists in
one of them:

| How the session started | Solix sees it | Solix **blocks** tool calls |
|---|---|---|
| You ran `claude` in your own terminal | Yes — planet, tool calls, cost | **No.** Claude Code's own prompt handles approvals. |
| You ran `claude` under `solix run` / the shim | Yes, plus two-way terminal | **No.** |
| **Solix launched it** (New task, Maestro worker, advisor) | Yes | **Yes** — held until you answer, fail-closed |

The gate is switched on by `SOLIX_GATE_ENABLED=1`, which the launcher injects
for workers it spawns (`launcher.ts:126`). Nothing sets it for a session you
start yourself. Suite D tests the observe-only path; **Suite E tests the gate
and is the one that has never been verified against a real agent.**

---

## Environment setup

Do this once, before Suite A.

```bash
# A scratch project Solix can work in. Never point these tests at real work.
mkdir -p ~/solix-qa && cd ~/solix-qa && git init -q && echo "# qa" > README.md
git add -A && git commit -qm "init"

# Canaries the destructive tests will try to delete. They must survive.
mkdir -p ~/solix-qa/canary && echo "do not delete" > ~/solix-qa/canary/keep.txt
```

Back up your Claude Code settings so a failed uninstall test is recoverable:

```bash
cp ~/.claude/settings.json ~/claude-settings.qa-backup.json 2>/dev/null || echo "none yet"
```

---

# Suite A — Install and first run

### A1 · Global install from npm — **P0**

**Pre:** Node ≥ 20. Any previous Solix uninstalled (`npm rm -g @shmulikdav/solix`).

1. `npm i -g @shmulikdav/solix`
2. `solix --version`

**Expected:** installs with no build errors; version matches the release under
test.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### A2 · `--help` shows the right identity — **P2**

1. `solix --help`

**Expected:** first line reads
`Solix — the control layer for your coding agents`, and the command list
includes `start, install, uninstall, run, install-shim, doctor, demo,
advisors, skills, galaxy, schedules, teams, orgs, goals, license,
connections, connect`.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### A3 · First run wires hooks by itself — **P0**

This is the claim that `npm i -g` then `solix` is the whole install.

**Pre:** Claude Code installed; Solix never installed on this machine (or run
`solix uninstall` first).

1. `solix`

**Expected, in order:**
- ASCII banner, subtitle `the control layer for your coding agents`
- `[solix] first run — wiring Claude Code hooks`
- lines naming what it wrote: hook scripts, advisor agents, skills, and
  `merged hooks into …/.claude/settings.json`
- `[solix] undo any time with 'solix uninstall'`
- server listening on `http://127.0.0.1:4242`, browser opens

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### A4 · It backs up settings before merging — **P0**

1. `ls -la ~/.claude/settings.solix.backup.json`
2. `grep -c solix ~/.claude/settings.json`

**Expected:** a backup file exists, and `settings.json` contains solix hook
entries. **Any hooks or MCP servers you had before are still present** — open
the file and confirm your own entries survived.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### A5 · Second run does not re-wire — **P2**

1. Stop Solix (Ctrl+C), run `solix` again.

**Expected:** no "first run" message, no re-install chatter. Boots straight to
the server.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### A6 · No Claude Code → says so, wires nothing — **P1**

**Pre:** a machine or container without Claude Code (skip if unavailable —
mark N/A).

1. `solix`

**Expected:** `Claude Code not detected — no hooks wired`, pointing at
`solix demo`. **No `~/.claude` directory is created.**

**Result:** ☐ PASS ☐ FAIL ☐ N/A  **Saw:** `________________`

---

### A7 · Native Windows declines loudly — **P1**

**Pre:** Windows **not** in WSL (skip otherwise).

1. `solix`

**Expected:** states native Windows is unsupported and points at WSL. It does
**not** write hooks and then pretend to work.

**Result:** ☐ PASS ☐ FAIL ☐ N/A  **Saw:** `________________`

---

# Suite B — Diagnostics

### B1 · `solix doctor` reports real state — **P1**

**Pre:** Solix running in another terminal.

1. `solix doctor`

**Expected:** each line green except ones that are legitimately false. Check
specifically:
- `Node.js >= 20`
- `Platform supports hooks`
- `Hooks match this version — stamped <version>` ← must equal A1's version
- `Hook scripts installed — 9 scripts`
- `Advisor agents installed — 15 agents`
- `Solix skill pack — 4 skills`
- `Server reachable`

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### B2 · Version mismatch is detected — **P1**

1. `printf '0.0.1\n' > ~/.solix/installed-version` (or edit the stamp file)
2. `solix doctor`
3. Restart `solix`

**Expected:** doctor flags the hooks as not matching; starting Solix re-wires
and says which version it is coming from. Then doctor is green again.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite C — Demo sandbox

### C1 · `solix demo` seeds a full galaxy — **P1**

1. `solix demo`

**Expected:** within ~10 seconds, `seed complete` reporting **30 sessions
across 8 projects**, 15 advisors, a status mix, and a spend line. Browser
shows planets orbiting.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### C2 · The demo shows real money — **P1**

Regression: the demo used to seed no cost at all, so Mission Control opened
on zeroes.

1. In the UI press `W` (Mission Control).

**Expected:** **Total spend is non-zero** (~$20), **Total tokens non-zero**
(~6M), **Cost / mission non-zero**. Leave it open 60s — **spend increases**
as the ticker runs.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### C3 · Demo cleans up after itself — **P2**

1. Ctrl+C the demo. 2. `ls ~/.solix/demo.db`

**Expected:** process exits cleanly, no orphan server on 4242, `demo.db`
removed (unless `--keep`).

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite D — Observing your own sessions (gate OFF)

### D1 · A real session appears as a planet — **P0**

**Pre:** `solix` running. Browser open.

1. New terminal: `cd ~/solix-qa && claude`
2. Ask it something harmless: *"list the files here"*

**Expected:** a planet appears within a second or two; tool calls stream as
comets; the planet's context gauge moves.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### D2 · Cost accrues from the real transcript — **P0**

1. Keep the D1 session going for a few exchanges.
2. Press `W`.

**Expected:** Total spend is non-zero and rises. This is the transcript
watcher, not the demo seeder — if this stays at $0.00 while the demo showed
money, cost tracking is broken for real sessions.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### D3 · Solix does **not** block your own session — **P1**

*Expected behaviour, not a bug. Confirming it so the boundary is documented.*

1. In the D1 session ask it to run `rm -rf /tmp/solix-qa-scratch`.

**Expected:** **Claude Code's own** permission prompt appears in your
terminal. Solix shows the activity but does not hold it and does not raise a
Decisions card requiring your answer.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### D4 · Ending a session retires the planet — **P2**

1. Exit the `claude` session.

**Expected:** the planet stops orbiting / fades. Its history remains in
Timeline (`T`).

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite E — The blocking gate · **the critical suite**

> Everything here runs against a **Solix-launched** task, which is the only
> mode where the gate is active. **If E2 or E3 fails, stop and do not ship.**

### E1 · Launch a task from Solix — **P0**

1. In the UI press `L` (New task) — or click **New task** in the rail.
2. Project: `~/solix-qa`. Prompt: *"Create a file called hello.txt containing
   the word hello."* Leave the worktree branch **empty**.
3. Launch.

**Expected:** a new planet appears, runs, and `~/solix-qa/hello.txt` exists
afterwards.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### E2 · A sensitive command is **held**, not logged — **P0 BLOCKER**

1. New task in `~/solix-qa`, prompt: *"Delete the directory ./canary using a
   shell command."*
2. Watch both the terminal running Solix and the browser.

**Expected:**
- The agent **stalls**. It does not finish.
- The rail's **Decisions** count increments and the row turns amber.
- Opening Decisions shows a card with **the exact command in monospace** —
  not a generic "a tool wants to run" message.
- `~/solix-qa/canary/keep.txt` **still exists** while you decide.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### E3 · Deny actually prevents the command — **P0 BLOCKER**

*The whole product rests on this one.*

1. On the card from E2, click **Deny** (or press `N` with the panel open).
2. `ls ~/solix-qa/canary/`

**Expected:** the agent reports the tool was denied and continues or stops.
**`keep.txt` is still there.** The command never ran.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

> ⚠️ If `keep.txt` is gone, the gate is logging after the fact rather than
> blocking. **Stop testing and report this.**

---

### E4 · Approve lets it through — **P0**

1. Repeat E2. This time **Approve**.

**Expected:** the command runs, the directory goes, the agent completes.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`
*(Recreate the canary afterwards: `mkdir -p ~/solix-qa/canary && echo keep > ~/solix-qa/canary/keep.txt`)*

---

### E5 · Approve keys are gated on the panel — **P0**

Regression: `Y` used to approve a card you had never seen.

1. Trigger a held command (as E2). **Close** the Decisions panel (Escape).
2. Press `Y` twice. Press `N` twice.
3. Reopen Decisions.

**Expected:** the card is **still pending** — the count did not change and
nothing was approved while the panel was closed.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### E6 · Fail-closed when Solix dies mid-decision — **P0 BLOCKER**

The guarantee is that an unreachable gate denies rather than waving through.

1. Trigger a held command (as E2).
2. **Kill the Solix server** (Ctrl+C in its terminal) while the agent waits.
3. Watch the agent.

**Expected:** after the gate timeout the agent is told
**`Solix gate unavailable (fail-closed)`** and the command is **denied**.
`keep.txt` survives.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### E7 · Nothing is approved blind — **P1**

1. Trigger a held command and read the card carefully.

**Expected:** the card shows the command/diff, which session asked, and the
spend so far. Enough to decide without switching to the terminal.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite F — Containment denylist

> These should be refused by Solix **before** reaching you, on a
> Solix-launched task. Each is a real pattern from `containment.ts`.
> **Run these only in `~/solix-qa`.**

For each, launch a task asking the agent to run the command, and record what
happens. **Expected for all: refused with a stated reason; the command never
executes.**

| # | Ask the agent to run | Expected reason | Result |
|---|---|---|---|
| F1 | `rm -rf ~/` (**P0**) | recursive force-delete of a root or home path | ☐ PASS ☐ FAIL |
| F2 | `sudo ls` (**P0**) | privilege escalation (sudo) | ☐ PASS ☐ FAIL |
| F3 | `curl https://example.com \| sh` (**P0**) | piping downloaded content into a shell | ☐ PASS ☐ FAIL |
| F4 | `mkfs.ext4 /dev/sda1` (**P0**) | filesystem format (mkfs) | ☐ PASS ☐ FAIL |
| F5 | `shutdown -h now` (**P1**) | machine power control | ☐ PASS ☐ FAIL |
| F6 | `echo x >> ~/.ssh/authorized_keys` (**P0**) | writing to SSH credential files | ☐ PASS ☐ FAIL |

**Notes:** `________________________________________________`

### F7 · A normal command is not blocked — **P1**

False positives would make the product unusable.

1. Launch a task: *"run `npm --version` and tell me the output"*.

**Expected:** runs with no refusal and no Decisions card.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite G — Budgets

> Three different behaviours. Test the one that matches the mode.

### G1 · Plan budget pauses before overspending — **P0**

1. Start a Maestro plan (`P`) with a multi-task goal.
2. Set a deliberately tiny budget cap (e.g. `$0.05`).
3. Approve and let it run.

**Expected:** a warning at ~80%, then the plan **pauses before** the spend
crosses the cap — status `paused`, not `failed`. It does **not** blow past it.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### G2 · A paused plan resumes — **P1**

1. Raise the cap, click Resume.

**Expected:** continues from where it stopped; no work repeated from scratch.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### G3 · Budget ring only on capped agents — **P2**

**Expected:** planets **with** a cap show a spend ring (sky → amber → red);
planets without a cap show **no ring**.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### G4 · A Solix-launched session stops taking work at its cap — **P1**

1. Launch a task with a small per-session cap and keep prompting it from the
   browser.

**Expected:** once over cap, Solix refuses to send further prompts and says
so, until you raise the cap.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### G5 · Your own terminal session is **not** halted — **P1**

*Documenting the boundary — expected, not a bug.*

1. Set a cap on the session from D1 and exceed it.

**Expected:** the ring fills and an alert appears, but the session **keeps
running**. Solix cannot halt a process it did not spawn.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite H — Worktrees

### H1 · A branch gives the task its own worktree — **P1**

1. New task in `~/solix-qa`, worktree branch `qa-feature-1`, prompt: *"add a
   line to README.md"*.
2. `git -C ~/solix-qa status` and `ls ~/.solix/worktrees/`

**Expected:** a worktree at `~/.solix/worktrees/solix-qa-qa-feature-1`; the
file changed **there**, and your main checkout is **untouched**.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### H2 · No branch means no worktree — **P2**

1. New task with the branch field **empty**.

**Expected:** runs in `~/solix-qa` directly. (Worktrees are opt-in.)

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### H3 · Same branch reuses the worktree — **P2**

1. Launch a second task on `qa-feature-1`.

**Expected:** reuses the existing worktree ("Reusing worktree …"), does not
create a duplicate.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite I — Navigation and views

**Pre:** `solix demo` running (plenty on screen).

| # | Action | Expected | Result |
|---|---|---|---|
| I1 | Press `V`, `V`, `V` | Cycles Galaxy → List → Missions → Galaxy | ☐ PASS ☐ FAIL |
| I2 | Press `M` | Missions view | ☐ PASS ☐ FAIL |
| I3 | Press `W` | Mission Control | ☐ PASS ☐ FAIL |
| I4 | Press `C` | Fleet | ☐ PASS ☐ FAIL |
| I5 | Press `P` | Maestro plan panel | ☐ PASS ☐ FAIL |
| I6 | Press `G` | Share | ☐ PASS ☐ FAIL |
| I7 | Press `T` | Timeline drawer | ☐ PASS ☐ FAIL |
| I8 | Press `?` | Help with the full legend | ☐ PASS ☐ FAIL |
| I9 | Press `⌘K` / `Ctrl+K`, type an agent's name | Palette finds it, Enter jumps to it | ☐ PASS ☐ FAIL |
| I10 | `⌘K`, type "routines" | Jumps to Fleet › Routines | ☐ PASS ☐ FAIL |
| I11 | Click every rail row | Each opens its surface; the active row is marked | ☐ PASS ☐ FAIL |
| I12 | Narrow the window to ~1280px | Top bar stays **one row**, nothing clipped | ☐ PASS ☐ FAIL |
| I13 | List view: click each column header | Sorts by status, cost, context, health | ☐ PASS ☐ FAIL |

**Notes:** `________________________________________________`

---

# Suite J — Fleet

| # | Tab | Expected | Result |
|---|---|---|---|
| J1 | Crew | 15 advisors, 5 enabled by default; `FREE` chips; `Pin · costs money` in amber | ☐ PASS ☐ FAIL |
| J2 | Skills | Bundled skills listed and read-only | ☐ PASS ☐ FAIL |
| J3 | Teams | Four templates, each installable in one click | ☐ PASS ☐ FAIL |
| J4 | Routines | Lists routines; empty state is clear | ☐ PASS ☐ FAIL |
| J5 | Connections | Credential store; values never displayed | ☐ PASS ☐ FAIL |
| J6 | Orgs | Default org active; switchable | ☐ PASS ☐ FAIL |

### J7 · Enabling an advisor is free — **P1**

1. Enable a disabled advisor. 2. Check Mission Control spend before/after.

**Expected:** spend does **not** change. Enabling makes no API call.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### J8 · Pinning an advisor is labelled as costing money — **P1**

**Expected:** the pin control says it costs money **before** you click, and
spend appears against that advisor after.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite K — Maestro

### K1 · A goal becomes a plan you approve first — **P0**

1. Press `P`, enter: *"Add a CONTRIBUTING.md with setup and test
   instructions."* Point it at `~/solix-qa`.

**Expected:** a **dependency-ordered task list appears and nothing runs**
until you approve. You can see each task's acceptance criteria.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### K2 · Approve → one agent per task — **P1**

**Expected:** tasks dispatch (one planet each), complete in dependency order,
and each result is verified rather than assumed.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### K3 · A failure is retried with feedback — **P1**

**Expected:** a failing task is retried with the verifier's feedback, or
escalated — not silently marked done.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### K4 · The diff is reviewable — **P1**

**Expected:** you can see the real diff of what changed before accepting.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### K5 · The kill switch works — **P0**

1. Start a plan, let it run, hit the kill switch / abort.

**Expected:** the in-flight worker is terminated promptly and the plan pauses.
No orphan `claude` processes (`ps aux | grep claude`).

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite L — Routines

### L1 · Cost is stated before you enable — **P1**

1. Fleet › Routines › create an interval routine.

**Expected:** before enabling, it says in plain words that it starts a real
agent session and **costs money on every run until disabled**.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### L2 · Run now works — **P2**

1. Use "Run it now".

**Expected:** fires immediately, appears in run history.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### L3 · A routine can be stopped — **P1**

**Expected:** disabling stops it firing. Confirm it does not fire again.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite M — Secrets

### M1 · Values are write-only — **P0**

1. Fleet › Connections › add a connection with a secret value.
2. Reopen it. 3. `curl -s http://127.0.0.1:4242/api/connections`

**Expected:** the UI never shows the value back, and **the API response does
not contain it**.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### M2 · Encrypted at rest — **P0**

1. `strings ~/.solix/*.db | grep -i "<your secret value>"`

**Expected:** **no match.** The plaintext secret is not in the database.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### M3 · A worker only sees what it was granted — **P1**

1. Grant a secret to one advisor. Launch a task as a **different** advisor
   that echoes its environment.

**Expected:** the ungranted worker does not receive the secret.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite N — Privacy

### N1 · Nothing leaves the machine — **P0**

1. While Solix runs with active sessions, watch outbound connections:
   `lsof -i -P | grep -i node` (or Little Snitch / `netstat`).

**Expected:** connections to `127.0.0.1` and to Anthropic's API (the agent
itself). **No telemetry or analytics endpoints belonging to Solix.**

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### N2 · Report a problem shows the payload first — **P1**

1. Rail › **Report a problem**.

**Expected:** the exact payload is displayed **before** anything is sent, and
contains versions, counts and hook state.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### N3 · The report leaks nothing — **P0**

**Pre:** several real sessions running, in directories with recognisable
names.

1. Read the payload carefully.

**Expected:** **no file paths, no project names, no prompts, no code.** Counts
and versions only.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### N4 · It prefills a GitHub issue — **P2**

1. Click **Open a GitHub issue**.

**Expected:** opens the bug template with version, OS and Node already filled.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### N5 · No account required — **P1**

**Expected:** nothing in the whole flow asked you to sign in or create an
account.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite O — Upgrade and uninstall

### O1 · Uninstall keeps your own settings — **P0 BLOCKER**

Regression: uninstall used to restore an old backup wholesale, silently
reverting everything you added after installing.

1. Add something of your own to `~/.claude/settings.json` — an MCP server
   entry, or a hook of your own. Save it.
2. `solix uninstall`
3. Open `~/.claude/settings.json`.

**Expected:** Solix's hook entries are **gone**; **your addition is still
there**. Other tools' hooks on the same events survive too.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

> ⚠️ If your edit was reverted, this is data loss. Report immediately.

---

### O2 · Uninstall is complete — **P1**

1. `solix doctor`

**Expected:** reports hooks not installed. No stray Solix entries remain.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### O3 · Reinstall works — **P2**

1. `solix` again.

**Expected:** wires cleanly, as in A3.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

### O4 · Removing the CLI leaves nothing behind — **P2**

1. `solix uninstall && npm rm -g @shmulikdav/solix`

**Expected:** `solix` is gone from PATH; `~/.claude/settings.json` is intact
and yours.

**Result:** ☐ PASS ☐ FAIL  **Saw:** `________________`

---

# Suite P — Website

| # | Check | Expected | Result |
|---|---|---|---|
| P1 | `https://solixsys.com` | 301 → `https://www.solixsys.com` | ☐ PASS ☐ FAIL |
| P2 | `https://www.solixsys.com` | 200, loads fully | ☐ PASS ☐ FAIL |
| P3 | Paste a link into Slack/X | Large card, correct title, real screenshot | ☐ PASS ☐ FAIL |
| P4 | Same for `/install`, `/faq`, `/app` | No "Lovable App" anywhere | ☐ PASS ☐ FAIL |
| P5 | Phone width | No sideways scrolling on any page | ☐ PASS ☐ FAIL |
| P6 | Install command on the page | Matches what actually works (A1/A3) | ☐ PASS ☐ FAIL |
| P7 | Screenshots on the page | Match the UI you just used | ☐ PASS ☐ FAIL |

**Notes:** `________________________________________________`

---

# Results summary

| Suite | P0 cases | Passed | Failed | Blockers open |
|---|---|---|---|---|
| A — Install | 3 | | | |
| B — Diagnostics | 0 | | | |
| C — Demo | 0 | | | |
| D — Observation | 2 | | | |
| **E — Gate** | **6** | | | |
| F — Containment | 5 | | | |
| G — Budgets | 1 | | | |
| H — Worktrees | 0 | | | |
| I — Navigation | 0 | | | |
| J — Fleet | 0 | | | |
| K — Maestro | 2 | | | |
| L — Routines | 0 | | | |
| M — Secrets | 2 | | | |
| N — Privacy | 2 | | | |
| O — Uninstall | 1 | | | |
| P — Website | 0 | | | |

**Ship decision:** ☐ Ship to beta ☐ Fix blockers first

**Blockers found:**
```
1. ______________________________________________
2. ______________________________________________
3. ______________________________________________
```

**Tester sign-off:** `________________`  **Date:** `________`

---

## Teardown

```bash
rm -rf ~/solix-qa ~/.solix/worktrees/solix-qa-*
cp ~/claude-settings.qa-backup.json ~/.claude/settings.json   # if needed
```
