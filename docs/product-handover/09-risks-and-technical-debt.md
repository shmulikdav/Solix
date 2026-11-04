# 09 · Known Issues, Risks & Technical Debt

[← Package index](README.md) · Related: [07 · Current status](07-current-status.md) · [08 · Backlog](08-backlog-and-roadmap.md) · [`docs/THREAT-MODEL.md`](../THREAT-MODEL.md)

**Severity:** Critical / High / Medium / Low. **Likelihood** is given only where evidence supports it, and is otherwise "—". **Owner** is a recommended role, because no named owners exist besides the repository owner.

## Summary

| ID | Item | Type | Severity | Status |
|---|---|---|---|---|
| R-01 | Single maintainer; most code AI-authored | Organisational | **High** | Open |
| R-02 | No validated users or product-market fit | Product | **High** | Open |
| R-03 | The denylist matches text, so it can be evaded by obfuscation | Security | Medium | Accepted by design, documented |
| R-04 | Rules aren't a sandbox: allowed programs can do anything | Security | Medium | Accepted by design, documented |
| R-05 | Dead sessions stay "active" | Defect (suspected) | Medium | Open |
| R-06 | An old server keeps running after an upgrade; the message is unclear | UX / defect | Medium | Open |
| R-07 | Users on 1.20.0–1.20.2 keep known rule holes; no update notice | Security | **High** | Mitigation pending (B-01) |
| R-08 | Dependence on Claude Code's hook contract | External | **High** | Open |
| R-09 | Agent View parses an undocumented format | External | Low | Mitigated (defensive parsing, off switch) |
| R-10 | Stale long-form documentation | Docs debt | Medium | Open |
| R-11 | Hard-coded model prices | Data accuracy | Medium | Open |
| R-12 | No field observability | Operational | Medium | Accepted (privacy promise) |
| R-13 | No database backup; losing `secret.key` loses secrets | Data | Medium | Open |
| R-14 | Inconsistent public shutdown-time statements | Accuracy | Low | Open |
| R-15 | Unbounded database growth; UI scale | Performance | Medium | Open |
| R-16 | Native-module ABI breakage | Platform | Medium | Open |
| R-17 | Stale claim text (parallel-limit default) | Accuracy | Low | Open |
| R-18 | Several tools bypass Solix's gate | Security | Medium | Accepted, documented |
| R-19 | Real-agent behaviour verified manually only | Quality | **High** | Open |
| R-20 | The release depends on the maintainer's machine | Operational | Medium | Partly mitigated |
| R-21 | Verifier cost of about 3× plain Claude Code | Product / cost | Medium | Open |
| R-22 | Website outside the repository, access unknown | Operational | Medium | Unknown |

---

<a id="r-01"></a>
### R-01 · Single maintainer; most code AI-authored
- **Evidence:**
  - Git authorship: 205 of 299 commits are "Claude", 94 are the owner.
  - No other contributors.
  - No `CONTRIBUTING.md`.
- **Impact:** All context, release rights and decisions sit with one person. AI-authored code is heavily tested here, which mitigates it, but the design rationale lives in commit messages, PR descriptions and session records rather than in any reviewer's head.
- **Mitigation:**
  - This package.
  - `CONTRIBUTING.md` ([B-13](08-backlog-and-roadmap.md#b-13)).
  - A second maintainer with release rights.
  - Keep using the claims ledger as executable documentation.
- **Owner:** the PM, with the repository owner.

<a id="r-02"></a>
### R-02 · No validated users or product-market fit
- **Evidence:**
  - 0 GitHub issues.
  - No telemetry (by design).
  - No partner records.
  - The roadmap's adoption goals haven't started.
- **Impact:** The roadmap is driven by the builder's judgement and adversarial self-evaluation, not by users.
- **Mitigation:** The design-partner loop ([B-10](08-backlog-and-roadmap.md#b-10)) before more features.
- **Owner:** the PM.

<a id="r-03"></a>
### R-03 · The denylist matches text
- **Evidence:** `packages/server/src/containment.ts` `deniedCommandReason` uses regular expressions. The threat model states that it "matches text, so it's a backstop, not a complete list of everything harmful".
- **Impact:** A determined or confused agent can phrase a destructive command in a form the patterns miss. The approval gate still holds anything not covered by a rule, so the exposure is mostly at `observe`, or under broad allow rules.
- **Mitigation:**
  - Keep the layered model.
  - Recommend sandboxing for untrusted work.
  - Grow the 30-cell matrix as cases are found.
- **Owner:** engineering.

<a id="r-04"></a>
### R-04 · Rules aren't a sandbox
- **Evidence:** `docs/THREAT-MODEL.md` "What no rule can see". `npm test`, `node file.js` and `node -e` run arbitrary code once allowed.
- **Impact:** A user who reads "approval rules" as "isolation" over-trusts the defaults.
- **Mitigation:**
  - Documented in the threat model, README and `GATE.md`.
  - The pitch must not imply isolation.
  - Recommend containers for CI.
- **Owner:** the PM, for messaging.

<a id="r-05"></a>
### R-05 · Dead sessions stay "active"
- **Evidence:**
  - The owner's UI showed "17 active · 464 idle".
  - Code review: startup clears stale `awaiting_permission` rows (`router.ts` `clearStalePermissionHolds`) but nothing transitions `active` sessions whose process has gone.
  - **Not yet confirmed** against the real process count.
- **Impact:** The headline counter is wrong, which erodes trust in every other number.
- **Likelihood:** High for anyone who closes terminals or crashes sessions.
- **Mitigation:** A liveness sweep ([B-04](08-backlog-and-roadmap.md#b-04)).
- **Owner:** engineering.

<a id="r-06"></a>
### R-06 · An old server keeps running after an upgrade
- **Evidence:** Observed on 2026-11-03:
  - after `npm i -g`, the UI still showed the old version;
  - `solix` printed "port in use";
  - the hooks were updated while the server was not.
- **Impact:** Users run a mismatched hook and server pair. A security fix in the server (for example 1.20.1–1.20.3) doesn't take effect until a manual `kill`.
- **Mitigation:** [B-06](08-backlog-and-roadmap.md#b-06).
- **Owner:** engineering.

<a id="r-07"></a>
### R-07 · Users on older versions keep known holes
- **Evidence:** 1.20.0–1.20.2 auto-allowed outside-project paths (`CHANGELOG.md` 1.20.1–1.20.3). Solix has no "a newer version exists" check against npm; `UpdateBanner.tsx` only compares the browser bundle with the running server.
- **Impact:** Users don't learn about security releases unless they watch GitHub or npm.
- **Mitigation:**
  - Publish 1.20.3 ([B-01](08-backlog-and-roadmap.md#b-01)).
  - Consider an **opt-in** update check, which would need to respect `CLAIM-NO-TELEMETRY` ([Q-14](10-decisions-and-open-questions.md#q-14)).
  - Use GitHub security advisories.
- **Owner:** the PM, with engineering.

<a id="r-08"></a>
### R-08 · Dependence on Claude Code's hook contract
- **Evidence:** The gate relies on `PreToolUse` hooks returning `permissionDecision`, on `--settings`, and on the transcript JSONL format. `SECURITY.md` notes "the enforcing gate depends on Claude Code honoring the PreToolUse permissionDecision contract."
- **Impact:** An Anthropic change could silently disable the gate or break cost tracking.
- **Mitigation:**
  - A stand-in agent contract test exists (`gate.contract.test.ts`, `launcher.integration.test.ts`).
  - Add a scheduled real-`claude` smoke run.
  - State the minimum supported version ([Q-08](10-decisions-and-open-questions.md#q-08)).
- **Owner:** engineering.

<a id="r-09"></a>
### R-09 · Agent View format undocumented
- **Evidence:** `state/agentview.ts` header ("schema of state.json isn't formally documented").
- **Mitigation:** Defensive parsing; unknown states shown as unrecognised (`CLAIM-AGENTVIEW-REPORTS-WHAT-IT-SEES`); `SOLIX_DISABLE_AGENTVIEW=1` turns it off.

<a id="r-10"></a>
### R-10 · Stale long-form documentation
- **Evidence:** `CLI.md`, `OPERATING.md`, `SOLIX_DOCS_BUNDLE.md` and `DEMO_DEV.md` were last changed in May 2026 (v1.6/1.7 era) and contain no mention of Maestro, rules, levels or the gate. `docs/PARTNER-BRIEF.md` describes 1.18.3. `docs/LAUNCH-READINESS.md` already labels itself historical.
- **Impact:** A new user or contributor reads a different product.
- **Mitigation:** [B-08](08-backlog-and-roadmap.md#b-08).

<a id="r-11"></a>
### R-11 · Hard-coded model prices
- **Evidence:** `packages/shared/src/pricing.ts`.
- **Impact:** Cost figures drift when Anthropic changes prices or adds models.
- **Mitigation:** [B-25](08-backlog-and-roadmap.md#b-25).

<a id="r-12"></a>
### R-12 · No field observability
- **Evidence:** `CLAIM-NO-TELEMETRY`; no crash reporting.
- **Impact:** Field failures are invisible unless a user reports them, and the "Report a problem" flow exists but has produced 0 issues.
- **Mitigation:** Partner check-ins; the `solix doctor` output shared on request.

<a id="r-13"></a>
### R-13 · No database backup; losing the key loses secrets
- **Evidence:**
  - Only a reset copies history first (`CLAIM-RESET-KEEPS-A-COPY`).
  - Secrets are encrypted with `~/.solix/secret.key` (`crypto.ts`: "losing" the key makes secrets unrecoverable).
- **Mitigation:** [B-24](08-backlog-and-roadmap.md#b-24).

<a id="r-14"></a>
### R-14 · Inconsistent shutdown-time statements
- **Evidence:** The 1.20.0 release notes say shutdown is "well under a second, even with a browser tab open". `docs/E2E-SMOKE-TEST.md` measured **1,956 ms** with two held requests on 1.18.3.
- **Impact:** A public number that the project's own record contradicts.
- **Mitigation:** Re-measure and correct, or bind it to a claim.

<a id="r-15"></a>
### R-15 · Unbounded data and UI scale
- **Evidence:**
  - No retention or pruning in `packages/server/src`.
  - The owner's database holds 481+ sessions.
  - List not virtualised; one DOM label per planet (`docs/PARTNER-BRIEF.md`).
- **Mitigation:** [B-05](08-backlog-and-roadmap.md#b-05), [B-24](08-backlog-and-roadmap.md#b-24), [B-26](08-backlog-and-roadmap.md#b-26).

<a id="r-16"></a>
### R-16 · Native-module ABI breakage
- **Evidence:** On 2026-11-03 a source checkout failed with a `better-sqlite3` ABI 115 vs 127 mismatch after a Node version change. Fixed with `pnpm rebuild -r better-sqlite3`. `node-pty` carries the same risk.
- **Impact:** Install and upgrade failures, especially across Node versions.
- **Mitigation:** Doctor detection; documented fix; consider prebuilt binaries per Node ABI.

<a id="r-17"></a>
### R-17 · Stale claim text
- **Evidence:** `docs/CLAIMS.md`, `CLAIM-PARALLEL-LIMIT-ENFORCED`: "default 1, serial". The code: `db.ts` `DEFAULT 2`, `state/plans.ts` `?? 2`.
- **Mitigation:** [B-07](08-backlog-and-roadmap.md#b-07).

<a id="r-18"></a>
### R-18 · Several tools bypass Solix's gate
- **Evidence:** The hook matchers in `packages/cli/src/install.ts`: `Task`, `Read|Write|Edit|MultiEdit`, `Bash`. `Glob`, `Grep`, `WebFetch`, `WebSearch`, `NotebookEdit` and MCP tools are not routed.
- **Impact:** For example, `WebFetch` could send data out without a Solix hold. Claude Code's own permissions still apply.
- **Mitigation:** Documented in `docs/THREAT-MODEL.md`. Decide whether to route more tools ([Q-15](10-decisions-and-open-questions.md#q-15)).

<a id="r-19"></a>
### R-19 · Real-agent behaviour verified manually only
- **Evidence:**
  - CI uses stand-in agents.
  - `docs/CLAIMS.md` lists 16 historical "overclaim" defects, where the product said X and did X-minus-something. Several were found only by real-machine runs.
  - 33 features are tested but not verified.
- **Mitigation:** [B-16](08-backlog-and-roadmap.md#b-16); a periodic real-machine smoke run before each release.

<a id="r-20"></a>
### R-20 · The release depends on the maintainer's machine
- **Evidence:** `release:tag` and `release:notes` run locally with `gh`. On 2026-11-03, pasted commands with inline comments accidentally published 1.20.0 through `release:notes` (since fixed: `--verify-tag`, upfront argument validation).
- **Mitigation:** Guards are in place. Document the release runbook in `CONTRIBUTING.md`.

<a id="r-21"></a>
### R-21 · Verifier cost
- **Evidence:** `docs/EVAL.md`: Solix about $5.45 against about $1.80 for plain Claude Code on the eval task. The ≤$4 target was missed.
- **Mitigation:** Cheaper-model routing (named in the 1.20 roadmap, not built). Make verification optional per task ([Q-16](10-decisions-and-open-questions.md#q-16)).

<a id="r-22"></a>
### R-22 · Website outside the repository
- **Evidence:** Referenced in docs; earlier deploys were blocked on a Cloudflare credential. Its source and hosting aren't in this repository.
- **Mitigation:** [Q-06](10-decisions-and-open-questions.md#q-06).

---

## Technical debt register (engineering-facing)

| Debt | Where | Effect on future work |
|---|---|---|
| A single-process server with in-memory pending holds | `router.ts` | Restart handling needs special cases (already present). Blocks horizontal scale and multi-user |
| `http.ts` holds ≈115 routes in one module | `packages/server/src/http.ts` | Change friction, review difficulty |
| Migration via `ensureColumn` plus one table-rebuild path; no versioned migrations | `db.ts` | Downgrades and complex schema changes are risky |
| Hand-rolled shell parsing for rules | `shared/src/approvalRules.ts`, `state/rules.ts` | A recurring source of security bugs (three fixed on 2026-11-03). Consider a real shell parser |
| Dormant registry half | `cloud.ts`, `/api/galaxy/registry*` | Unused surface ([B-35](08-backlog-and-roadmap.md#b-35)) |
| Stale branches | 8 remote branches | Confusion ([B-34](08-backlog-and-roadmap.md#b-34)) |
| Repository renamed (`SolariX` → `Solix`); some clones and remotes use the old name | git remote | GitHub redirects for now; a cosmetic risk |
