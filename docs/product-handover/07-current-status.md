# 07 · Current Product Status

[← Package index](README.md) · Related: [04 · Feature inventory](04-feature-inventory.md) · [08 · Backlog](08-backlog-and-roadmap.md) · [09 · Risks](09-risks-and-technical-debt.md)

**Snapshot date:** 2026-11-03 · **`main`:** `9091b59` (PR #55 merged) · **npm `latest`:** 1.20.2 · **Open PRs:** none · **Open GitHub issues:** none

## Release state

| Version | State | What it carries |
|---|---|---|
| 1.20.0 | Published 2026-11-03 | Approval rules, sticky denials, Host validation, parallel Maestro, `solix gate` (it absorbed the never-published 1.19.0) |
| 1.20.1 | Published 2026-11-03 | **Security:** redirect targets seen by rules |
| 1.20.2 | Published 2026-11-03 (**current `latest`**) | `solix rules test`, policy `extends`, confined regex rules (security) |
| **1.20.3** | **Merged, NOT published** | **Security:** the rules see every path; reads are confined. Adds `docs/THREAT-MODEL.md` |

Publishing 1.20.3 needs the maintainer to run `pnpm release:tag`, then `pnpm release:notes v1.20.3`, on `main`. That's about 10 minutes.

---

## A. What is done

Fifteen capabilities are **Completed & Verified**: they work end to end on a real machine, with recorded evidence. Thirty-three more are implemented and covered by automated tests but not verified in real use. Full list: [04](04-feature-inventory.md#summary).

**Verified core:**
- **Install, uninstall, never clobbering user settings.** Smoke run against the npm build of 1.18.3.
- **Observing sessions, with true cost and context.** The same smoke run, and the owner's machine.
- **The gate: hold, approve, deny, fail-closed on shutdown.** Smoke E2–E6, against a real `claude` 2.1.316.
- **The denylist floor at every level.** Smoke F8, plus a 30-cell automated matrix.
- **Maestro producing a passing result with zero interventions.** Eval runs on 1.18.3 and 1.19.
- **Approval rules taking holds from 30 to 4 on the eval task.** Eval run.
- **`solix gate` refusing uncovered calls in a real run.** The owner's Mac, 2026-11-03.
- **The ledger counting decisions correctly.** Smoke run.

**Testing status:** 1,372 automated tests in 125 files, all passing on `main`. 48 claims, each bound to a test. CI runs on every PR.

**Deployment status:** distributed via npm with provenance. There is no hosted component.

## B. What is in progress

| Item | State | Remaining | Blocker | Owner |
|---|---|---|---|---|
| **Release 1.20.3** (security fix plus threat model) | Merged | Tag, publish, GitHub Release, users upgrade | None. It needs the maintainer's machine | Maintainer |

**Nothing else is in active development.** There are no open PRs. The eight non-`main` remote branches are stale, last touched between May and September 2026:

`feat/demo-showcase-live`, `feat/galaxy-orbit-compression`, `fix/crew-empty-snapshot-fallback`, `fix/macos-hooks-and-modal-opacity`, `fix/panel-modal-collisions`, `fix/panel-opacity-bleed`, `launch/quick-wins`, `sprint-l-patch`.

These should be treated as abandoned until someone confirms otherwise ([Q-13](10-decisions-and-open-questions.md#q-13)). `claude/solix-command-center-z1y95` is the working branch for the AI-assisted sessions.

## C. What is to do

### C.1 Approved or agreed, not yet done

These come from the owner-agreed roadmap and launch plan in the 2026-11 working sessions. **They aren't recorded in a repository document**, so the incoming PM should confirm them ([Q-03](10-decisions-and-open-questions.md#q-03)).

| Item | Launch gate | Backlog |
|---|---|---|
| Publish 1.20.3 | Gate 1 | [B-01](08-backlog-and-roadmap.md#b-01) |
| Re-measure the eval on a real machine; update `docs/EVAL.md` and the release notes | Gate 2 | [B-03](08-backlog-and-roadmap.md#b-03) |
| First impression: stale active count, Galaxy at scale, port message | Gate 3 | [B-04](08-backlog-and-roadmap.md#b-04)–[B-06](08-backlog-and-roadmap.md#b-06) |
| README pitch rewrite (gate first); `CONTRIBUTING.md`; website refresh | Gate 4 | [B-12](08-backlog-and-roadmap.md#b-12)–[B-14](08-backlog-and-roadmap.md#b-14) |
| Launch post (Show HN / r/ClaudeAI) built on the measured comparison table | Launch | [B-15](08-backlog-and-roadmap.md#b-15) |
| 1.20 roadmap remainder: several people at the gate, `solix status`, `ledger --json`, Codex hold | Post-launch | [B-20](08-backlog-and-roadmap.md#b-20)–[B-23](08-backlog-and-roadmap.md#b-23) |

### C.2 Planned in repository documents

| Item | Source | Backlog |
|---|---|---|
| Solix Teams server (proprietary, increment 2) | `docs/TEAMS-SPEC.md` | [B-30](08-backlog-and-roadmap.md#b-30) |
| SIEM export | `docs/MONETISATION.md` | [B-22](08-backlog-and-roadmap.md#b-22) |
| Postgres / S3 storage adapters | `state/orgs.ts` message | [B-31](08-backlog-and-roadmap.md#b-31) |
| Codex human gate | `docs/CODEX-PROBE.md`, `docs/multi-runtime.md` | [B-23](08-backlog-and-roadmap.md#b-23) |

### C.3 Known defects and gaps

| Item | Severity | Ref |
|---|---|---|
| Sessions whose process died stay "active" (suspected; owner saw "17 active" among 481) | Medium | [R-05](09-risks-and-technical-debt.md#r-05) |
| `docs/CLAIMS.md` states `CLAIM-PARALLEL-LIMIT-ENFORCED` with "default 1, serial". The code default is **2** since 1.20.0. The claim text is stale | Low (but it's a false public statement) | [R-17](09-risks-and-technical-debt.md#r-17) |
| Long-form docs (`CLI.md`, `OPERATING.md`, `SOLIX_DOCS_BUNDLE.md`, `DEMO_DEV.md`) describe v1.7. They never mention Maestro, rules, levels or the gate | Medium | [R-10](09-risks-and-technical-debt.md#r-10) |
| `docs/PARTNER-BRIEF.md` describes 1.18.3 | Low | [R-10](09-risks-and-technical-debt.md#r-10) |
| Orgs: routines not org-scoped; storage adapters absent | Medium (for Teams) | [F-65](04-feature-inventory.md) |
| Share: the registry half has no UI and no registry service | Low | [F-67](04-feature-inventory.md) |
| Desktop-only; List not virtualised | Low–medium | [F-90](04-feature-inventory.md), [F-86](04-feature-inventory.md) |
| No `solix stop`; upgrading needs a manual `kill` | Low | [B-06](08-backlog-and-roadmap.md#b-06) |
| Codex normaliser never run against a live session | Low (experimental) | [F-69](04-feature-inventory.md) |

### C.4 Technical debt

See [09 · Risks & technical debt](09-risks-and-technical-debt.md). Headlines: a single maintainer; real-agent behaviour verified manually only; native modules; hard-coded prices; an unbounded database; no database backup routine.

## D. What is unknown

| Unknown | Why it matters | Question |
|---|---|---|
| Who uses Solix, and how many people | Every prioritisation call | [Q-01](10-decisions-and-open-questions.md#q-01) |
| Whether any design partner received the brief or is running Solix | It was the #1 recommended commercial move | [Q-04](10-decisions-and-open-questions.md#q-04) |
| Where the website lives, and who can deploy it | Launch Gate 4 | [Q-06](10-decisions-and-open-questions.md#q-06) |
| Whether `solix gate` works in hosted CI (GitHub Actions) | The CI pitch | [Q-07](10-decisions-and-open-questions.md#q-07) |
| The current live hold count after the scratchpad and path changes | The headline metric | [B-03](08-backlog-and-roadmap.md#b-03) |
| Whether GitHub Sponsors is enabled | Minor revenue and signal | [Q-02](10-decisions-and-open-questions.md#q-02) |
| The minimum supported Claude Code version | Support statements | [Q-08](10-decisions-and-open-questions.md#q-08) |
| Whether the 8 stale branches hold anything worth keeping | Hygiene, lost work | [Q-13](10-decisions-and-open-questions.md#q-13) |
| Whether an external security review has ever been done | The trust pitch | [Q-10](10-decisions-and-open-questions.md#q-10) |
