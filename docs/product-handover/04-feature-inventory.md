# 04 · Feature Inventory

[← Package index](README.md) · Related: [03 · PRD](03-complete-prd.md) · [05 · Journeys](05-user-journeys.md) · [07 · Status](07-current-status.md)

Every capability found in the repository, with an evidence-based status. Code paths are relative to the repository root.

## Status definitions

| Status | Definition, as applied in this package |
|---|---|
| **Completed & Verified** | Implemented, covered by automated tests, **and** observed working end to end against a real agent on a real machine: in `docs/E2E-SMOKE-TEST.md`, `docs/EVAL.md`, or the owner's recorded runs. |
| **Implemented, Not Verified** | Code and automated tests exist, but there is no record of the feature working end to end in real use. Most features are here, which is a fair description of a PILOT-stage product. |
| **Partially Implemented** | Some of the documented capability exists; a stated part is missing. |
| **In Progress** | Merged or underway but not yet released. |
| **Planned** | Documented as intended (roadmap, spec, docs) and not built. |
| **Proposed** | Recommended in this audit or in a working session, with no evidence of approval. |
| **Blocked** | Waiting on an identified dependency. |
| **Unknown** | Insufficient evidence either way. |

"Tests" below means automated tests in the repository; all 1,372 pass on `main` as of `9091b59`. `CLAIM-*` IDs refer to [`docs/CLAIMS.md`](../CLAIMS.md), where each public claim is bound to one test file.

## Summary

| Status | Count | Features |
|---|---|---|
| Completed & Verified | **15** | F-01, F-02, F-03, F-04, F-05, F-13, F-14, F-20, F-21, F-22, F-25, F-28, F-30, F-40, F-41 |
| Implemented, Not Verified | **33** | F-06–F-12, F-15, F-16, F-23, F-24, F-27, F-29, F-31–F-34, F-42–F-50, F-60–F-64, F-66, F-68 |
| In Progress | **1** | F-26 (merged, release 1.20.3 not yet published) |
| Partially Implemented | **3** | F-65, F-67, F-69 |
| Planned | **6** | F-70, F-80, F-81, F-82, F-84, F-88 |
| Blocked | **1** | F-83 |
| Proposed | **3** | F-85, F-86, F-87 |
| Unknown | **2** | F-89, F-90 |
| **Total** | **64** | |

---

## A. Observe: seeing the fleet

| ID | Feature | Status | Verification evidence |
|---|---|---|---|
| F-01 | Install, hook wiring, uninstall | **Completed & Verified** | Smoke A1–A4, O1 on the 1.18.3 registry build; `CLAIM-INSTALL-NEVER-CLOBBERS`, `CLAIM-UNINSTALL-RESTORES`, `CLAIM-ONE-HOOK-SET` |
| F-02 | Live session tracking | **Completed & Verified** | Smoke D1; owner's galaxy, 2026-11-03 |
| F-03 | Cost tracking from transcripts | **Completed & Verified** | Smoke "the figures" (`costUsd: 0.4435`); `CLAIM-COST-COUNTED-ONCE` |
| F-04 | Context-window percentage | **Completed & Verified** | Smoke (`contextUsagePct: 19.66`); `CLAIM-CONTEXT-IS-MEASURED` |
| F-05 | Galaxy (3D view) | **Completed & Verified** for ordinary fleet sizes | Owner screenshots, 2026-11-03; `CLAIM-RENDERER-RELEASES-GPU`. **Scale gaps:** see F-86 |
| F-06 | List view | Implemented, Not Verified | `listCollapse.test.tsx`. Not virtualised (`docs/PARTNER-BRIEF.md`) |
| F-07 | Mission Control (workspace overview) | Implemented, Not Verified | `missionControl.test.ts` |
| F-08 | Missions & live mission logs | Implemented, Not Verified | `/api/missions` has **no UI caller**, so its role is unclear ([Q-12](10-decisions-and-open-questions.md#q-12)) |
| F-09 | Timeline | Implemented, Not Verified | `timeline.test.ts`; `CLAIM-DISABLED-MEANS-DISABLED` |
| F-10 | Import history | Implemented, Not Verified | `importHistory.test.ts` |
| F-11 | Agent View mirroring | Implemented, Not Verified | `agentview.test.ts`; `CLAIM-AGENTVIEW-REPORTS-WHAT-IT-SEES`. Parses an **undocumented** Anthropic file format |
| F-12 | Two-way terminal (`solix run`) | Implemented, Not Verified | `runUngated.test.ts`; `CLAIM-RUN-UNGATED` (it is deliberately **not** gated) |
| F-13 | Demo mode | **Completed & Verified** | Smoke C1; `CLAIM-DEMO-SEEDS-OR-SAYS` |
| F-14 | Doctor / diagnostics | **Completed & Verified** | Smoke B1 ("All checks passed" on a real install); `CLAIM-DOCTOR-REPORTS-REAL-STATE` |
| F-15 | The band (Claude Code status-line plugin) | Implemented, Not Verified | `plugin/solix-band/hooks/*.test.tsx` |
| F-16 | Notifications: browser, Slack, Telegram | Implemented, Not Verified | `notifyOnHold.test.ts`, `notifiers.test.ts`; `CLAIM-NOTIFY-ON-HOLD`. No live Slack/Telegram run recorded |

<details><summary><b>Feature cards: F-01 to F-16</b></summary>

**F-01 · Install, hook wiring, uninstall**
- **Purpose:** Get Solix between Claude Code and its tools without breaking the user's own configuration.
- **Current behaviour:**
  - The first `solix` run merges nine hook entries into `~/.claude/settings.json`, after taking a backup, and says exactly what it changed.
  - `solix uninstall` removes only Solix's own entries.
  - Hooks are recognised **by name, wherever they live**, so a second Solix home doesn't double-wire.
- **Business rules:**
  - The user's settings are never overwritten.
  - The backup is preserved once.
  - If Claude Code isn't present, Solix says so and wires nothing.
- **Edge cases:**
  - Malformed `settings.json`: Solix refuses and explains.
  - Native Windows: refused (README; smoke A7).
- **Code:** `packages/cli/src/install.ts`, `uninstall.ts`, `start.ts`; hook scripts in `packages/cli/hooks/*.sh`.
- **Acceptance:** Given a settings file with user entries, when Solix installs and then uninstalls, the file is byte-equivalent to the original except for Solix's entries.

**F-02 · Live session tracking**
- **Purpose:** Every Claude Code session on the machine is visible.
- **Current behaviour:**
  - Hook events (session start, prompt, tool use, stop, notification) are POSTed to `127.0.0.1:4242/events`.
  - The router upserts the session and broadcasts it over WebSocket.
- **Code:** `packages/server/src/router.ts`, `state/sessions.ts`, `ws.ts`.
- **Known gap:** a session whose process dies without a Stop event stays `active` indefinitely (suspected; see F-85, [R-05](09-risks-and-technical-debt.md#r-05)).

**F-03 · Cost tracking**
- **Behaviour:** Reads each session's Claude Code transcript, counts each line's token usage **once**, and prices it from a built-in table.
- **Code:** `packages/server/src/state/transcript.ts`, `packages/shared/src/pricing.ts`.
- **Risk:** prices are hard-coded, so an Anthropic price change makes figures wrong until a release ([R-11](09-risks-and-technical-debt.md#r-11)).

**F-04 · Context percentage**
- **Behaviour:** Measured from the transcript, not estimated. Before 1.18.3 it was `0` for the life of every install.
- **Code:** `packages/server/src/state/context.ts`.

**F-05 · Galaxy**
- **Behaviour:** A React Three Fiber scene. Each session is a planet grouped by project, with advisors in an inner ring, skills as an asteroid belt, and missions as comets. A red flare means a session needs you.
- **Code:** `packages/web/src/scene/*`.
- **Known gaps:**
  - At hundreds of sessions the scene is unreadable, because idle sessions dominate.
  - There is one DOM label per planet.
  - The "active" counter may be inflated by stale sessions. Seen on the owner's machine: 481 sessions, "17 active".

**F-06 · List view**
- **Behaviour:** A table of sessions with collapse-by-project.
- **Code:** `packages/web/src/hud/ListView.tsx`.
- **Gap:** not virtualised.

**F-07 · Mission Control**
- **Behaviour:** Click the sun to see total spend, cost per completed mission, and what needs attention.
- **Code:** `packages/web/src/panels/WorkspacePanel.tsx`.

**F-08 · Missions**
- **Behaviour:** Mission records derived from sessions (start, end, status, metrics), plus live mission logs tailed from transcripts.
- **Code:** `packages/server/src/state/missions.ts`, `packages/web/src/hud/MissionView.tsx`.

**F-09 · Timeline**
- **Behaviour:** A chronological feed derived at query time. No separate storage.
- **Code:** `packages/server/src/state/timeline.ts`, `packages/web/src/hud/TimelineDrawer.tsx`.

**F-10 · Import history**
- **Behaviour:** `solix import` backfills the galaxy from existing Claude Code transcripts.
- **Code:** `packages/cli/src/import.ts`, `packages/server/src/state/importHistory.ts`.

**F-11 · Agent View mirroring**
- **Behaviour:** Mirrors Claude Code "Agent View" background sessions, read-only, from `~/.claude/daemon/roster.json` and `~/.claude/jobs/*/state.json`.
- **Code:** `packages/server/src/state/agentview.ts`.
- **Risk:** the file format is undocumented and parsed defensively ([R-09](09-risks-and-technical-debt.md#r-09)).
- **Off switch:** `SOLIX_DISABLE_AGENTVIEW=1`.

**F-12 · `solix run`**
- **Behaviour:** Wraps `claude` in a pseudo-terminal so the UI can type into the session (`node-pty`).
- **Business rule:** it does **not** govern the session. This is documented and claim-tested.
- **Code:** `packages/cli/src/run.ts`, `packages/server/src/state/wrappers.ts`.

**F-13 · Demo**
- **Behaviour:** `solix demo` seeds about 30 synthetic sessions in an isolated demo database.
- **Code:** `packages/cli/src/demo.ts`.

**F-14 · Doctor**
- **Behaviour:** `solix doctor [--port]` checks the hooks, the server, the token, and version skew.
- **Code:** `packages/cli/src/doctor.ts`.

**F-15 · Band**
- **Behaviour:** A Claude Code plugin that shows pending decisions, with Approve/Deny, or a fleet summary above the prompt. It needs a running Solix.
- **Code:** `plugin/solix-band/`.

**F-16 · Notifications**
- **Behaviour:**
  - The browser notifies when a decision is held and the tab is in the background.
  - Optional Slack or Telegram notifiers (`/api/notifiers`) send the command. Approval stays local.
- **Code:** `packages/web/src/notifications.ts`, `packages/server/src/state/notifiers.ts`.

</details>

---

## B. Govern: the gate and its records

| ID | Feature | Status | Verification evidence |
|---|---|---|---|
| F-20 | Human approval gate (hold → approve/deny) | **Completed & Verified** | Smoke E2/E3/E4 on the 1.18.3 registry build; `CLAIM-GATE-HOLDS-LAUNCHED`, `CLAIM-GATE-ANY-PORT` |
| F-21 | Fail-closed on timeout, outage or shutdown | **Completed & Verified** | Smoke E6 (1,956 ms, both holds refused); `CLAIM-FAILCLOSED`, `CLAIM-SHUTDOWN-RELEASES` |
| F-22 | Command denylist ("the floor") at every level | **Completed & Verified** | Smoke F8; `gate.matrix.test.ts` (30 cells); `CLAIM-FLOOR-ALL-LEVELS`, `CLAIM-FLOOR-NO-SESSION` |
| F-23 | Confinement of worker file writes to the project | Implemented, Not Verified | `containment.test.ts`, `router.containment.test.ts` |
| F-24 | Governance levels (observe / standard / strict) | Implemented, Not Verified | `governance.gate.test.ts`, `governance.downgrade.test.ts`; `CLAIM-DOWNGRADE-NEEDS-FORCE`. Smoke E11 is defined but no run is recorded |
| F-25 | Approval rules: defaults, add, "Always allow", Rules tab | **Completed & Verified** | The eval run on a real machine (holds 30 → 4, 27 decided by rule); the owner's `solix gate` runs on 2026-11-03; `CLAIM-RULES-NEVER-OVERRIDE-FLOOR`, `CLAIM-AUTO-DECISIONS-LABELLED` |
| F-26 | Rule path confinement (security hardening, 1.20.1–1.20.3) | **In Progress** (1.20.3 unpublished) | `rules.test.ts`, `router.rules.test.ts`; `CLAIM-RULES-SEE-REDIRECTS`, `CLAIM-ALLOW-RULES-CONFINED`, `CLAIM-RULES-SEE-EVERY-PATH`, `CLAIM-READS-CONFINED`. **Unit-proven only.** 1.20.1 and 1.20.2 are published; 1.20.3 is merged |
| F-27 | Sticky denials, restart pauses, downgrade needs force | Implemented, Not Verified | `router.sticky.test.ts`, `orchestrator/sticky.test.ts`; `CLAIM-DENY-IS-STICKY`, `CLAIM-DENY-STOPS-RETRY`, `CLAIM-RESTART-PAUSES-ON-HOLD`. Smoke E9/E10 defined, no run recorded |
| F-28 | Headless CI gate (`solix gate`) | **Completed & Verified** | The owner's runs on macOS with a real `claude`, 2026-11-03: refusal reached the agent, counted once, exit 3. `gate.test.ts`; `CLAIM-HEADLESS-FAILS-CLOSED`, `CLAIM-GATE-ONE-HOOK-SET` |
| F-29 | `solix rules test` and policy `extends` | Implemented, Not Verified | `rulesTest.test.ts`, `gate.test.ts`; `CLAIM-RULES-TEST-IS-THE-GATE`, `CLAIM-POLICY-EXTENDS-DEFAULTS`. Built CLI exercised in CI-like conditions only |
| F-30 | Decision ledger (`solix ledger`) | **Completed & Verified** | Smoke ("2 decisions in the window"); `CLAIM-LEDGER-COUNTS-EVERYTHING` |
| F-31 | Signed report (`solix report`) | Implemented, Not Verified | `report.test.ts`. Reports were produced by the owner's `solix gate` runs, but signature verification by a third party has not been exercised |
| F-32 | "What was prevented" (`solix gain`, `/api/impact`) | Implemented, Not Verified | `impact.test.ts`. `/api/impact` has no UI caller |
| F-33 | Reporting client to a company server (Teams increment 1) | Implemented, Not Verified | `reporting.test.ts`. **No receiving server exists** |
| F-34 | Local API security (token, loopback, Host and Origin checks) | Implemented, Not Verified | `host.guard.test.ts`, `ws.host.test.ts`, `origins.test.ts`; `CLAIM-HOST-IS-OURS`, `CLAIM-WS-ORIGIN`. No external security review recorded |

<details><summary><b>Feature cards: F-20 to F-34</b></summary>

**F-20 · Human approval gate**
- **Purpose:** The product's core promise. A sensitive tool call waits for a person.
- **Behaviour:**
  1. The `PreToolUse` hooks for `Bash`, `Read`, `Write`, `Edit`, `MultiEdit` and `Task` POST to `/events/permission` and block.
  2. The server checks the floor (F-22), confinement (F-23), the level (F-24), then the rules (F-25).
  3. If nothing decides, the server holds the call. It broadcasts a `permission_request` with the exact command, and the Decisions panel or the band shows it.
  4. The person approves or denies. The hook returns `permissionDecision` to Claude Code.
- **Who is gated:** agents Solix launches (Maestro workers and verifiers, New task, routines) and `solix gate` runs. A `claude` the user starts themselves is **not** gated unless they set `SOLIX_GATE_ENABLED=1`.
- **Business rules:**
  - A deny is final for the plan (F-27).
  - The timeout is 300 s by default (`SOLIX_GATE_TIMEOUT_MS`), then the call is denied.
- **Code:** `packages/server/src/router.ts` (`requestPermission`), `packages/cli/hooks/pre-tool-*.sh`, `packages/web/src/hud/DecisionQueue.tsx`.
- **Acceptance:** Given a Solix-launched worker at `standard` and no covering rule, when it runs `rm canary/keep.txt`, then the call is held showing that exact command, and on Deny the file still exists.

**F-21 · Fail-closed**
- **Behaviour:**
  - Launched agents get `SOLIX_GATE_POLICY=deny`. An unreachable server, a timeout or a shutdown means the call is refused.
  - On SIGTERM, held requests are refused and audited before the process exits.
- **Code:** `packages/server/src/launcher.ts` (`containmentGateEnv`), `create.ts` (shutdown).

**F-22 · Denylist floor**
- **Behaviour:**
  - A curated set of catastrophic patterns is refused at every level, even with no session row, and before any rule: recursive force-delete of `/`, `~` or system directories, a fork bomb, `mkfs`, `dd of=/dev/…`, `curl … | sh`, `sudo`/`su`, shutdown/reboot, `chmod -R 777 /`, `chown -R /`, and writes to SSH keys.
  - It applies only to agents Solix launched.
- **Code:** `packages/server/src/containment.ts` (`deniedCommandReason`).
- **Limit:** matches text, so it's a backstop, not exhaustive ([R-03](09-risks-and-technical-debt.md#r-03)).

**F-23 · Confinement**
- **Behaviour:** For contained roles (worker, verifier, routine), a `Write`/`Edit` outside the project is refused.
- **Code:** `containment.ts` (`evaluateContainment`).

**F-24 · Governance levels**
- **Behaviour:**
  - `observe`: nothing is held, but the floor still applies.
  - `standard` (the default): calls from Solix-launched plans and tasks are held.
  - `strict`: routines are held too.
  - Lowering the level while workers run needs `--force`.
  - Each session stores the level it launched under.
- **Code:** `packages/server/src/state/governance.ts`, `packages/cli/src/level.ts`.

**F-25 · Approval rules**
- **Behaviour:**
  - Standing decisions are evaluated after the floor and before a person is asked. Match kinds: `readonly_tool`, `write_inside_root`, `command_prefix`, `command_regex`. Each rule is allow or deny. Deny wins.
  - A shell command is covered only when **every segment** is covered.
  - Decisions made by rules are audited separately from human decisions (`permission_auto_*`).
  - Rules carry hit counts.
  - The defaults are opt-in (`solix rules defaults`).
- **Code:** `packages/server/src/state/rules.ts`, `packages/shared/src/approvalRules.ts`, `packages/cli/src/rules.ts`, `packages/web/src/panels/fleet/RulesTab.tsx`.
- **Acceptance:** Given the default rules, when a worker runs `cat package.json | head -60`, it is allowed by rule with no hold. When it runs `git push`, it is held.

**F-26 · Rule path confinement**
- **Behaviour:** An allow rule never covers a path outside the project or the session scratchpad, however it's spelled: variables, `..`, redirects, option values, symlinks, or `<( … )`. `Read`, `Grep` and `Glob` are confined too.
- **Why it matters:** before 1.20.1, the defaults auto-allowed `echo x >~/.bashrc`. Before 1.20.3, they allowed `Read ~/.ssh/id_ed25519`.
- **Status reason:** the last part is merged but **not yet published** (1.20.3).
- **Docs:** `docs/THREAT-MODEL.md`.

**F-27 · Denials that stick**
- **Behaviour:**
  - A person's deny refuses the same normalised command for the rest of the plan.
  - A task whose attempt was denied escalates to a person instead of retrying.
  - A plan with a hold abandoned by a restart comes back **paused**.
- **Code:** `packages/server/src/state/denials.ts`, `orchestrator/index.ts`.

**F-28 · `solix gate`**
- **Behaviour:**
  1. Starts a private headless server on a temporary home and a free port.
  2. Loads a policy file, or `defaults`.
  3. Runs the agent with the gate's hooks via `--settings`.
  4. Refuses anything the policy doesn't cover, at once.
  5. Writes `audit.json`, a signed `report.json` and `report.md`.
- **Exit codes:** the agent's own code; `3` if anything was refused; `2` for a bad policy.
- **Code:** `packages/cli/src/gate.ts`. **Docs:** `docs/GATE.md`.

**F-29 · Rule testing and policy extends**
- **Behaviour:**
  - `solix rules test [--rules file|defaults] "<cmd>"` prints the gate's verdict and the uncovered segment. Exit 0 if allowed, 1 if not, 2 for a bad policy.
  - A policy file can be `{ "extends": "defaults", "rules": [...] }`.
- **Code:** `packages/cli/src/rulesTest.ts`, `gate.ts` (`loadPolicy`).

**F-30 · Ledger**
- **Behaviour:** `solix ledger [--days] [--md|--csv]` shows the decisions in a window, with patterns worth a second look (for example "approved 4 times — worth a rule").
- **Code:** `packages/cli/src/ledger.ts`, `packages/server/src/state/ledger.ts`.

**F-31 · Signed report**
- **Behaviour:** A hash-chained, ed25519-signed export of an audit window, as JSON or Markdown. `solix report --verify` checks it.
- **What it proves:** who produced it, and that it hasn't been edited. It does **not** prove completeness.
- **Code:** `packages/server/src/state/report.ts`, `packages/cli/src/report.ts`.

**F-32 · Gain**
- **Behaviour:** `solix gain` summarises what was prevented: blocked commands and budget pauses.
- **Code:** `packages/cli/src/gain.ts`.

**F-33 · Reporting client**
- **Behaviour:** `solix reporting enable|preview|push|status|disable`. Off by default. Sends decision records only, never prompts, code or diffs. Uses `audit_events` with a high-water mark as its queue. Supports an `https://` or `file:` endpoint.
- **Code:** `packages/server/src/state/reporting.ts`, `packages/cli/src/reporting.ts`.

**F-34 · Local API security**
- **Behaviour:**
  - Listens on loopback only.
  - A token in `~/.solix/token` (mode 0600) is required on the ingestion endpoints.
  - The `Host` header must be loopback (or `SOLIX_ALLOWED_HOSTS`), which defeats DNS rebinding.
  - The browser's `Origin` is checked, and the WebSocket's `Origin` is checked.
- **Code:** `packages/server/src/http.ts`, `origins.ts`, `ws.ts`.

</details>

---

## C. Build: running agents

| ID | Feature | Status | Verification evidence |
|---|---|---|---|
| F-40 | New task (launch one agent from the UI) | **Completed & Verified** | Smoke E1 |
| F-41 | Maestro core loop: goal → plan → approve → dispatch → verify → retry → review | **Completed & Verified** on the eval task | `docs/EVAL.md`: 1.18.3 and 1.19 runs passed with 0 interventions; `orchestrator.test.ts`, `retry.test.ts`, `planner.test.ts` |
| F-42 | Plan editing (reorder, retitle, re-prompt, criteria, model, add/drop) | Implemented, Not Verified | `http.planedit.test.ts`, `planEditUi.test.tsx`; `CLAIM-VERIFIED-TERMS-FIXED` |
| F-43 | Budget caps (plan and session) | Implemented, Not Verified | `CLAIM-BUDGET-PAUSES-BEFORE-THE-CAP`; `http.planspend.test.ts`. Smoke G1 is defined; no run is recorded |
| F-44 | Full-auto (skip plan approval) | Implemented, Not Verified | Refused unless worker containment is intact (`/api/system/containment`) |
| F-45 | A git worktree per task with a branch | Implemented, Not Verified | `launcher.test.ts`, `git.test.ts`. Smoke H1–H3 defined |
| F-46 | Parallel Maestro (isolated tasks in worktrees, integrate back) | Implemented, Not Verified | `orchestrator/parallel.test.ts` (real git); `CLAIM-PARALLEL-INTEGRATES`, `CLAIM-PARALLEL-LIMIT-ENFORCED`. Depends on the planner marking tasks `isolated` |
| F-47 | Task threads (per-task conversation) | Implemented, Not Verified | `threads.test.ts`, `http.thread.test.ts` |
| F-48 | Review diff and preview the result | Implemented, Not Verified | `http.preview.test.ts`, `baseRefNote.test.tsx` |
| F-49 | Routines (interval, webhook or manual triggers; editable) | Implemented, Not Verified | `schedules.test.ts`, `http.routineedit.test.ts`; `CLAIM-ROUTINE-EDIT-KEEPS-HISTORY` |
| F-50 | Goals ("constellations") → plans | Implemented, Not Verified | `/api/plans/from-goal` |

<details><summary><b>Feature cards: F-40 to F-50</b></summary>

**F-41 · Maestro**
- **Behaviour:**
  1. A planner session (model `opus`) decomposes the goal into dependency-ordered tasks with acceptance criteria and roles.
  2. A person approves the plan, unless full-auto is on.
  3. Each ready task gets a worker session. When the worker stops, a verifier session (model `haiku`) checks the acceptance criteria.
  4. A failure retries with feedback up to `maxAttempts`, then **escalates** to a person.
  5. When the plan finishes, the person reviews the diff against the plan's base ref.
- **States:** see [03 § 9](03-complete-prd.md#9-data-model--business-logic).
- **Code:** `packages/server/src/orchestrator/*`, `packages/web/src/panels/PlanPanel.tsx`.
- **Known cost profile:** about 3× plain Claude Code on the eval task, because of the verifier pass (`docs/EVAL.md`).

**F-43 · Budget caps**
- **Behaviour:**
  - A plan with `budgetUsd` pauses before spend exceeds the cap.
  - A Solix-launched session stops taking work at its cap.
  - `GET /api/plans/:id` returns `spendUsd`.
  - The user's own terminal sessions are never halted.

**F-46 · Parallel Maestro**
- **Behaviour:**
  - Up to `parallelLimit` tasks run at once (default 2). Only independent tasks marked `isolated` qualify, each in its own worktree.
  - Changes are integrated back into the plan checkout one at a time.
  - A conflict escalates to a person, and nothing is silently merged.
- **Gap:** a task that depends on in-progress work isn't parallelised.

**F-49 · Routines**
- **Behaviour:**
  - Scheduled prompts with interval, webhook (`POST /api/triggers/:token`) or manual triggers.
  - The cost is stated before enabling.
  - Editing keeps the run history and the webhook token.
  - Routines run under the denylist; at `strict`, they are held too.
- **Code:** `packages/server/src/state/schedules.ts`, `orchestrator/scheduler.ts`, `packages/web/src/panels/fleet/RoutinesTab.tsx`.

</details>

---

## D. Extend and configure

| ID | Feature | Status | Verification evidence |
|---|---|---|---|
| F-60 | Advisors: a crew of 15 specialist agents (enable, pin, invoke) | Implemented, Not Verified | `http.*` tests; `packages/agents/*.md` |
| F-61 | Crew plugin for Claude Code (`solix-crew`, works without Solix) | Implemented, Not Verified | `crew.sync.test.ts` keeps the plugin copy in sync. No install run recorded |
| F-62 | Skills: detect, install, author, version, test | Implemented, Not Verified | `http.skills.test.ts`, `skillAuthoring.test.ts` |
| F-63 | Team templates (bundles of advisors, skills and routines) | Implemented, Not Verified | `teams.test.ts`; `CLAIM-TEAMS-IDEMPOTENT` |
| F-64 | Connections and secrets (encrypted, granted per worker) | Implemented, Not Verified | `connections.test.ts`; `CLAIM-SECRETS-WRITE-ONLY`. Smoke M1–M3 defined |
| F-65 | Orgs / tenants | **Partially Implemented** | `orgs.test.ts`. Routines are **not** org-scoped (`docs/PARTNER-BRIEF.md`); the Postgres/S3 backend is a placeholder message |
| F-66 | Galaxy share: export, import, versions, diff | Implemented, Not Verified | `CLAIM-IMPORT-NO-SSRF`. The import from a URL is SSRF-guarded |
| F-67 | Galaxy registry: publish and browse | **Partially Implemented** | Server and CLI only, **no UI** (`docs/PARTNER-BRIEF.md`). It needs `SOLIX_REGISTRY_URL`, and **no registry service is known to exist** ([Q-09](10-decisions-and-open-questions.md#q-09)) |
| F-68 | Report a problem (prefilled GitHub issue, payload shown first) | Implemented, Not Verified | `reportProblem.test.tsx`. Smoke N2–N4 defined |
| F-69 | Codex runtime | **Partially Implemented** (experimental) | `codex.test.ts`, `codex.probe.test.ts`. The normaliser has never run against a live Codex session; the gate does **not** cover Codex (`docs/multi-runtime.md`) |
| F-70 | Team storage backends (Postgres / S3) | **Planned** | Only a status message (`state/orgs.ts`: "when its adapters ship") |

---

## E. Planned, proposed and unknown

| ID | Feature | Status | Source |
|---|---|---|---|
| F-80 | Several people at the gate: claim, attribute, org-scoped | **Planned** | 1.20 roadmap item 2 (owner-agreed, working session; not in the repository) |
| F-81 | `solix status`: an agent reads its own budget, context and rules in force | **Planned** | 1.20 roadmap item 4 |
| F-82 | Ledger and audit export (`solix ledger --json`, SIEM) | **Planned** | 1.20 roadmap item 6; `docs/MONETISATION.md` (SIEM) |
| F-83 | Codex human hold via `PermissionRequest` | **Blocked** | Needs the run sheet in `docs/CODEX-PROBE.md` executed against a real `codex` |
| F-84 | Solix Teams server (proprietary) | **Planned** | `docs/TEAMS-SPEC.md` increment 2 |
| F-85 | Mark sessions idle when their process has died | **Proposed** | Audit finding, 2026-11-03 ([R-05](09-risks-and-technical-debt.md#r-05)) |
| F-86 | Galaxy at scale: hide idle sessions, virtualise the list, labels | **Proposed** | Owner screenshot of 481 sessions; `docs/PARTNER-BRIEF.md` |
| F-87 | A port-in-use message that names the running version and PID | **Proposed** | Owner confusion, 2026-11-03 |
| F-88 | Distribution: Homebrew tap, plugin manifest, `doctor --json` | **Planned** | 1.21 roadmap |
| F-89 | Native Windows | **Unknown** | Unsupported today (WSL works). No decision recorded on whether to support it |
| F-90 | Responsive / mobile layout | **Unknown** | `docs/PARTNER-BRIEF.md`: "It is desktop-only." No plan recorded |
