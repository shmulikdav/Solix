# 11 · PM Handover Guide

[← Package index](README.md)

The operational guide for your first month. Everything here links back to the evidence in documents 01–10.

---

## A. Product overview in 5 minutes

**What it is.** Solix is a free, open-source (MIT) tool that runs on a developer's own computer and supervises AI coding agents, chiefly Anthropic's **Claude Code**. It does three things:
1. **Asks before risky actions.** An agent Solix launched is stopped before it deletes, pushes or publishes, and a person approves or denies with the exact command in view. If nobody answers, or Solix is down, the action is refused.
2. **Shows the fleet.** Every agent session appears as a planet in a 3D "galaxy", with live cost and status. There's also a list view, an overview, and an in-terminal status line.
3. **Runs and checks work.** "Maestro" turns a goal into tasks, runs one agent per task, has a second agent verify each result, retries or escalates, and presents the diff for review.

On top of that:
- **standing rules**, so routine actions aren't asked about;
- a **CI mode** (`solix gate`) that runs agents unattended under a written policy;
- **records**: a ledger and a signed report;
- extras: 15 advisor agents, skills, scheduled routines, encrypted credentials for agents.

**Who it's for.**
- **Today:** individual developers running several Claude Code sessions.
- **Target:** engineering teams running agents daily, including in CI.
- **Future and paid:** organisations wanting central oversight ("Solix Teams", **not built**).

**Where it stands.**
- **Engineering:** strong. 1,372 tests, 48 test-bound public claims, an automated and verified publish pipeline, a written threat model. The core gate is verified end to end on real machines.
- **Product:** early. No known external users, one maintainer, no revenue.
- **Last 24 hours:** three security fixes to the approval rules. The last one (**1.20.3**) is merged but **not yet published**.

**What to do first.** Publish 1.20.3, re-measure the headline eval, fix the first-impression problems, then find design partners ([08](08-backlog-and-roadmap.md)).

---

## B. What the new PM needs to know immediately

### Critical product knowledge

1. **Solix only governs agents it started.** A `claude` you start yourself is observed, not gated, unless you opt in. Never let marketing say "all your agents" ([D-04](10-decisions-and-open-questions.md#d-04)).
2. **Rules are not a sandbox.** Allowing `npm test` allows whatever the tests do ([`docs/THREAT-MODEL.md`](../THREAT-MODEL.md)).
3. **The claims ledger is the culture.** Any public statement about behaviour needs a `CLAIM-*` entry and a test that fails if it's false ([`docs/CLAIMS.md`](../CLAIMS.md)). Treat a false sentence in docs as a defect.
4. **No telemetry is a promise, not an omission.** Any analytics would be a strategic change ([D-01](10-decisions-and-open-questions.md#d-01)).
5. **"Verified" in this package means seen working on a real machine.** Only 15 of 64 capabilities meet that bar ([04](04-feature-inventory.md#summary)).

### Urgent risks

| Risk | Why now | Ref |
|---|---|---|
| 1.20.0–1.20.2 users have known rule holes; 1.20.3 is unpublished | Security | [B-01](08-backlog-and-roadmap.md#b-01), [R-07](09-risks-and-technical-debt.md#r-07) |
| The headline metric (30 → 4 holds) is stale | Launch credibility | [B-03](08-backlog-and-roadmap.md#b-03) |
| "Active" count probably wrong at scale | First impression | [R-05](09-risks-and-technical-debt.md#r-05) |
| No safe vulnerability-disclosure channel (`SECURITY.md` points to public issues) | Security process | [Q-10](10-decisions-and-open-questions.md#q-10) |
| Single maintainer | Continuity | [R-01](09-risks-and-technical-debt.md#r-01) |

### Current blockers

| Blocker | Unblocks |
|---|---|
| The maintainer must run the release commands | 1.20.3 |
| A real machine with `claude` is needed for the eval | Launch numbers |
| Website access is unknown | Launch gate 4 |

### Active priorities

These are agreed in the working sessions; confirm them via [Q-03](10-decisions-and-open-questions.md#q-03):

| Launch gate | What |
|---|---|
| 1 | Security of the rules: done, ships in 1.20.3 |
| 2 | Eval re-measured |
| 3 | First-impression fixes |
| 4 | README, `CONTRIBUTING.md`, website |
| — | Launch |

### Dependencies and architectural constraints

- **Claude Code's hook contract and transcript format** are the single biggest external dependency ([R-08](09-risks-and-technical-debt.md#r-08)).
- **Single-process and local.** Multi-user and Teams need new architecture ([06 § 9](06-technical-architecture.md#9-architectural-decisions-and-their-implications)).
- **Only six tools pass through the gate:** `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Task` ([R-18](09-risks-and-technical-debt.md#r-18)).

### Decisions awaiting confirmation

[Q-01](10-decisions-and-open-questions.md#q-01) users · [Q-02](10-decisions-and-open-questions.md#q-02) business path · [Q-03](10-decisions-and-open-questions.md#q-03) roadmap approval · [Q-10](10-decisions-and-open-questions.md#q-10) security review and disclosure.

---

## C. First 30 days action plan

### Week 1: Understand

- [ ] Read 01, 07, 08 and 10 in this package; skim 04.
- [ ] Install from npm on a clean machine. Run `solix demo`, then a real `claude`. Watch a planet appear ([J-01](05-user-journeys.md#j-01)).
- [ ] Launch a **New task** that tries `rm` on a scratch file. Approve once, deny once ([J-04](05-user-journeys.md#j-04)).
- [ ] Run a small Maestro goal end to end ([J-05](05-user-journeys.md#j-05)).
- [ ] Read [`docs/THREAT-MODEL.md`](../THREAT-MODEL.md), [`docs/CLAIMS.md`](../CLAIMS.md) and [`docs/EVAL.md`](../EVAL.md).
- [ ] Hold the interview with the owner ([§ D](#d-key-questions-for-the-outgoing-pm-and-engineering-lead)).

### Week 2: Validate

- [ ] Confirm 1.20.3 is published ([B-01](08-backlog-and-roadmap.md#b-01)). If not, get it done this week.
- [ ] Run, or have someone run, the eval ([B-03](08-backlog-and-roadmap.md#b-03)). Compare against the targets in [02 § 6](02-product-vision-and-strategy.md#6-goals-and-intended-outcomes).
- [ ] Walk the unrun manual checks from [B-16](08-backlog-and-roadmap.md#b-16): sticky deny, budget pause, kill switch, secrets. Update statuses in [04](04-feature-inventory.md).
- [ ] Confirm or refute the stale-"active" defect: `pgrep -fl claude | wc -l` against the UI count ([R-05](09-risks-and-technical-debt.md#r-05)).
- [ ] Try `solix gate` in a GitHub Actions workflow ([B-09](08-backlog-and-roadmap.md#b-09)).

### Week 3: Prioritise

- [ ] Decide the answers to [Q-02](10-decisions-and-open-questions.md#q-02) and [Q-03](10-decisions-and-open-questions.md#q-03) with the owner. Commit an approved `docs/ROADMAP.md`.
- [ ] Re-rank [08](08-backlog-and-roadmap.md) with what weeks 1–2 found.
- [ ] Identify 5–10 candidate design-partner teams. Prepare a current partner brief (the existing one describes 1.18.3).
- [ ] Settle the security disclosure channel and whether to commission a review ([Q-10](10-decisions-and-open-questions.md#q-10)).

### Week 4: Take ownership

- [ ] Agree the 30/60/90 plan ([08 § Indicative roadmap](08-backlog-and-roadmap.md#indicative-roadmap)) and the launch criteria.
- [ ] Agree the product metrics ([03 § 13](03-complete-prd.md#13-product-analytics--success-measurement)): eval numbers per release, partner count, externally found gate bugs.
- [ ] Agree the delivery process: PR review, who can release, the release runbook, keeping the claims ledger.
- [ ] Set the next milestone: launch readiness review against the four gates.

---

## D. Key questions for the outgoing PM and engineering lead

Here, the outgoing PM and the engineering lead are the same person: the repository owner.

**Users and market**
1. Who, outside this project, has installed Solix and used it for more than a day? How do you know?
2. Did the 1.18.3 partner brief go to anyone? What did they say?
3. Which three companies would you most want as design partners, and why?

**Strategy and business**
4. Is the Teams server still the plan? What evidence would make you build it, or drop it?
5. Is GitHub Sponsors enabled? Any revenue at all?
6. Is the launch-gate plan (gates 1–4, then Show HN) approved as-is?
7. What must Solix never do? Beyond no telemetry: are there other red lines?

**Product**
8. Why the galaxy? Would you keep it if partners preferred the list?
9. Why `opus` for planning and `haiku` for verification? Has anything cheaper been tried?
10. Should more tools (`WebFetch`, MCP) go through the gate, at the cost of more holds?
11. What is the support stance on Windows, on Codex, and on old Claude Code versions?

**Engineering and operations**
12. Who else can publish to npm? Where is `NPM_TOKEN` managed, and who can rotate it?
13. Where is the website's source and hosting, and who has deploy access?
14. Are any of the 8 stale branches worth keeping?
15. Has anyone outside reviewed the gate's security? How should a researcher report a vulnerability?
16. What is the process when Claude Code changes its hooks or transcript format? Has that happened before?
17. Are the AI-assisted working-session records kept anywhere the next person can read them?

---

## E. Product knowledge map

| Domain | Features | Requirements | Journeys | Architecture | Docs | Code |
|---|---|---|---|---|---|---|
| **Install and lifecycle** | F-01, F-13, F-14 | FR-INS-* | J-01, J-03, J-10 | [06 § 8](06-technical-architecture.md#8-deployment-release-and-cicd) | `README.md`, `docs/E2E-SMOKE-TEST.md` (A, B, C, O) | `packages/cli/src/{install,uninstall,start,doctor,demo}.ts`, `packages/cli/hooks/` |
| **Observation and cost** | F-02–F-12, F-15, F-16 | FR-OBS-* | J-02 | [06 § 3](06-technical-architecture.md#3-components) | `docs/E2E-SMOKE-TEST.md` (D) | `packages/server/src/router.ts`, `state/{sessions,transcript,context,missions,timeline,agentview}.ts`, `packages/web/src/scene/`, `packages/web/src/hud/` |
| **The gate** | F-20–F-24, F-27 | FR-GATE-* | J-04 | [06 § 7](06-technical-architecture.md#7-security-mechanisms) | `docs/THREAT-MODEL.md`, `SECURITY.md`, smoke E and F | `packages/server/src/{router,containment,launcher}.ts`, `state/{governance,denials}.ts`, `packages/web/src/hud/DecisionQueue.tsx` |
| **Approval rules** | F-25, F-26, F-29 | FR-RULE-* | J-06 | [06 § 3](06-technical-architecture.md#3-components) | `docs/THREAT-MODEL.md`, `docs/CLAIMS.md` | `packages/shared/src/approvalRules.ts`, `packages/server/src/state/rules.ts`, `packages/cli/src/{rules,rulesTest}.ts`, `packages/web/src/panels/fleet/RulesTab.tsx` |
| **CI gate** | F-28, F-29 | FR-CI-* | J-07 | [06 § 1](06-technical-architecture.md#1-the-shape-in-one-picture) | `docs/GATE.md` | `packages/cli/src/gate.ts` |
| **Records** | F-30–F-33 | FR-REC-* | J-08 | [06 § 5](06-technical-architecture.md#5-integrations) | `docs/TEAMS-SPEC.md` | `packages/server/src/state/{ledger,report,reporting,audit}.ts`, `packages/cli/src/{ledger,report,reporting,gain}.ts` |
| **Maestro** | F-40–F-48, F-50 | FR-MAE-* | J-05 | [06 § 6](06-technical-architecture.md#6-background-and-asynchronous-processing) | `docs/EVAL.md`, `README.md` § Maestro | `packages/server/src/orchestrator/`, `state/{plans,threads,worktrees,git}.ts`, `packages/web/src/panels/PlanPanel.tsx` |
| **Routines** | F-49 | FR-CFG-04 | J-09 | [06 § 6](06-technical-architecture.md#6-background-and-asynchronous-processing) | — | `state/schedules.ts`, `orchestrator/scheduler.ts`, `packages/web/src/panels/fleet/RoutinesTab.tsx` |
| **Crew, skills, teams** | F-60–F-63 | FR-CFG-03 | — | — | `plugin/README.md` | `packages/agents/`, `packages/skills/`, `state/{advisors,skills,skillAuthoring,teams}.ts`, `plugin/` |
| **Connections and secrets** | F-64 | FR-CFG-01/02 | — | [06 § 7](06-technical-architecture.md#7-security-mechanisms) | `SECURITY.md` | `state/connections.ts`, `crypto.ts` |
| **Orgs, share, registry** | F-65–F-67, F-70 | FR-CFG-06 | — | [06 § 5](06-technical-architecture.md#5-integrations) | `docs/PARTNER-BRIEF.md` | `state/{orgs,galaxy}.ts`, `cloud.ts`, `packages/web/src/panels/SharePanel.tsx` |
| **Codex** | F-69, F-83 | FR-NEW-06 | — | [06 § 5](06-technical-architecture.md#5-integrations) | `docs/multi-runtime.md`, `docs/CODEX-PROBE.md` | `packages/server/src/codex.ts` |
| **Release and quality** | — | NFR-10, NFR-13 | — | [06 § 8](06-technical-architecture.md#8-deployment-release-and-cicd) | `CHANGELOG.md`, `docs/releases/`, `docs/CLAIMS.md`, `docs/EVAL.md` | `scripts/{release-tag,publish-release-notes,emit-claims}.mjs`, `.github/workflows/` |
| **Strategy and history** | — | — | — | — | `docs/MONETISATION.md`, `docs/TEAMS-SPEC.md`, `docs/LAUNCH-READINESS.md` (historical), [10](10-decisions-and-open-questions.md) | — |
