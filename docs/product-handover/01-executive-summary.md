# 01 · Executive Summary

[← Package index](README.md) · Next: [02 · Vision & strategy](02-product-vision-and-strategy.md)

## Solix in one paragraph

**Solix** is free, open-source (MIT) software that a developer installs on their own computer to supervise **AI coding agents**: programs such as Anthropic's Claude Code that write and run code on their own. Solix shows every agent that is working, what each one is costing, and what it is doing. Before an agent takes a risky action, such as deleting files, publishing a package or pushing code, Solix stops the agent and asks a person to approve or deny it. It can also take a larger goal, break it into tasks, hand each task to its own agent, check the results, and present the finished work for review. Everything runs locally: no account, no cloud service, no telemetry.

## The problem it solves

Teams increasingly run several AI agents at once. Three things go wrong:

1. **Agents act without asking.** An agent can delete files, push code or run commands its owner never intended. Most of the time this is harmless; when it isn't, it's expensive.
2. **Nobody can see the whole fleet.** With several agents in several terminals, it's hard to know which one is stuck, which one needs an answer, and what the total is costing.
3. **There's no record.** Afterwards, nobody can show what an agent was allowed to do, who allowed it, and what it cost.

Solix answers all three: it **asks before risky actions**, **shows the whole fleet with live cost**, and **keeps a signed record of every decision**.

## Who it's for

| Segment | Status | Evidence |
|---|---|---|
| Individual developers running Claude Code | **Primary today.** The product is built and documented for them. | `README.md`, `DEMO.md`, the install flow |
| Engineering teams running agents daily, including in automated pipelines (CI) | **The current strategic target**, agreed by the owner in Nov 2026. Partly served today. | [D-07](10-decisions-and-open-questions.md#d-07), `docs/GATE.md` |
| Companies that want central oversight across many developers ("Solix Teams") | **Planned, not built.** A specification exists. No server exists. | `docs/TEAMS-SPEC.md`, `docs/MONETISATION.md` |
| Product managers | Addressed by a demo script only | `DEMO_PM.md` |

No user research, customer interviews or usage data exist in the repository. Who actually uses Solix is **unknown** ([Q-01](10-decisions-and-open-questions.md#q-01)).

## What it does today

| Capability | Plain-language description | Maturity |
|---|---|---|
| **The gate** | Stops an agent before a risky action and asks a person. If nobody answers, or Solix is down, the action is refused. | Verified on real machines |
| **Approval rules** | Standing answers ("always allow running tests") so people aren't asked about routine actions. Cut the asks on a test task from 30 to 4. | Verified on a real machine. A hardening of the rules is not yet published. |
| **The safety floor** | A short list of catastrophic commands that are always refused, whatever the settings. | Verified |
| **The galaxy view** | Every agent shown as a planet, with live cost and status | Verified for normal fleet sizes; struggles with hundreds of sessions |
| **Maestro** | Turns a goal into tasks, runs one agent per task, checks each result, and presents the changes for review | Verified on a sample task |
| **CI mode (`solix gate`)** | Runs an agent unattended under a written policy and refuses anything the policy doesn't cover | Verified on the owner's machine |
| **Records** | A decision ledger, a signed report, and a "what was prevented" summary | Ledger verified; the rest tested but not verified end to end |
| **Extras** | 15 specialist "advisor" agents, reusable skills, scheduled routines, encrypted credentials for agents, team templates | Built and tested, not verified end to end |

The full list of 64 capabilities and their statuses is in [04 · Feature inventory](04-feature-inventory.md).

## How mature it is

- **Release maturity:** 40 tagged releases since May 2026, several a day at the most recent peak. The current line is **1.20.x**.
- **Engineering discipline is unusually strong:**
  - 1,372 automated tests;
  - every public promise is tied to a test that fails if the promise breaks (48 "claims");
  - a written threat model;
  - releases that publish through an automated, verified pipeline.
- **Product maturity is early.** By the owner's own adversarial evaluation, Solix is at **PILOT** stage. The core works, but:
  - it has **no known external users**;
  - it has **one maintainer**;
  - its headline number (how often it interrupts people) has **not been re-measured** since the latest changes.

## The most important outstanding challenges

1. **Nobody outside the project is known to use it.** There are no issues, no customer data and no telemetry. Product-market fit is entirely unvalidated.
2. **Security trust is still being earned.** Three security fixes to the approval rules shipped, or were prepared, in a single day (2026-11-03). The last is merged but **not yet published** (1.20.3). Rules are a convenience, not a sandbox. This is now written down in `docs/THREAT-MODEL.md`.
3. **A single maintainer, and most code written with an AI assistant.** 205 of 299 commits (about 69%) are attributed to the AI assistant. Continuity depends on one person.
4. **First impressions at scale.** With hundreds of past sessions, the main view becomes an unreadable cloud, and its "active" count is probably wrong.
5. **The headline metric is stale.** The evaluation must be re-run on a real machine before launch.

## Immediate priorities for the incoming PM

1. **Publish 1.20.3.** It's a security fix, already merged, and needs about 10 minutes from the maintainer. [B-01](08-backlog-and-roadmap.md#b-01)
2. **Re-measure the evaluation** so the launch claims rest on a current measurement. [B-03](08-backlog-and-roadmap.md#b-03)
3. **Fix the first-impression problems**: the stale "active" count, the cluttered galaxy, the unclear port message. [B-04](08-backlog-and-roadmap.md#b-04)–[B-06](08-backlog-and-roadmap.md#b-06)
4. **Find real users** before building more: the planned design-partner loop. [B-10](08-backlog-and-roadmap.md#b-10)
5. **Decide the business model's next step.** Teams server, compliance pack, or design-partner contracts first: [Q-02](10-decisions-and-open-questions.md#q-02).
