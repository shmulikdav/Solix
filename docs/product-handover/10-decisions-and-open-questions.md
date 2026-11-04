# 10 · Product Decisions & Open Questions

[← Package index](README.md) · Related: [02 · Vision & strategy](02-product-vision-and-strategy.md) · [08 · Backlog](08-backlog-and-roadmap.md)

## Part 1 · Decisions

Recovered from repository documents, the changelog, PR descriptions, code comments and the 2026-11 working sessions. The **decision owner** is the repository owner in every case where an owner is evident; no other decision-maker appears in the record. **"Rationale unknown"** is stated wherever it is.

| ID | Decision | Date | Still relevant? |
|---|---|---|---|
| D-01 | Local-only: no account, no cloud backend, no telemetry | Since v1 (May 2026) | **Yes, core** |
| D-02 | Free and MIT, with no paid individual tier; dormant licensing removed | 2026-10-25/26 (1.14.0) | Yes |
| D-03 | Monetise through a separate, proprietary, self-hosted **Teams** server | 2026-10-25 | Yes, pending execution ([Q-02](#q-02)) |
| D-04 | Govern only agents whose environment Solix set; observe the rest | Pre-1.18 | Yes |
| D-05 | Every public claim is bound to a test that fails if it breaks | ~1.18.x (Oct 2026) | **Yes, core process** |
| D-06 | The denylist is a floor at every level, which no rule or level can lift | 1.18.0 | Yes |
| D-07 | Success means "a team and its agents run under Solix daily"; fix blockers before any adoption push | 2026-11 sessions | Yes ([Q-03](#q-03)) |
| D-08 | Approval rules are opt-in, and their decisions are recorded apart from human ones | 1.19 → 1.20.0 | Yes |
| D-09 | A verified task's acceptance criteria can't change afterwards | 1.18.3 | Yes |
| D-10 | Rules are standing decisions, not a sandbox; isolation is delegated | 1.20.3 | Yes |
| D-11 | 1.19.0 never published; its content shipped in 1.20.0 | 2026-11-03 | Historical |
| D-12 | Headless gate refuses uncovered calls at once (no 300 s hold) | 1.20.0 | Yes |
| D-13 | Parallel Maestro only for independent "isolated" tasks; conflicts escalate | 1.20.0 | Yes |
| D-14 | Keep `node` (including `node -e`) in the default rules | 1.20.3 | Yes, revisit with partners |
| D-15 | No native Windows (WSL only) | ≤1.13 | Open ([Q-05](#q-05)) |
| D-16 | Planner on `opus`, verifier on `haiku` | Unknown | **Rationale unknown** |
| D-17 | A 3D "galaxy" as the primary interface metaphor | v1 | **Rationale unknown**; now demoted in the pitch |

<details open><summary><b>Decision details</b></summary>

<a id="d-01"></a>
**D-01 · Local-only, no telemetry**
- **Context:** Agent transcripts and commands are sensitive.
- **Rationale (documented):** "Nothing ever leaves your machine" is a differentiator, so it is enforced by test (`CLAIM-NO-TELEMETRY`).
- **Consequences:**
  - Zero usage data, so product-market fit is invisible ([R-02](09-risks-and-technical-debt.md#r-02), [R-12](09-risks-and-technical-debt.md#r-12)).
  - Multi-user and Teams need new architecture.
  - No automatic update notices ([R-07](09-risks-and-technical-debt.md#r-07)).
- **Evidence:** `README.md`, `docs/CLAIMS.md`, `packages/server/src/noTelemetry.test.ts`.

<a id="d-02"></a>
**D-02 · Free, MIT, no Pro tier**
- **Context:** A complete Pro licensing system existed (`FREE_TASK_LIMIT` = 3 tasks per plan), but it was dormant: no public key was embedded.
- **Alternatives considered:** an MIT core plus a differently licensed Pro; keeping the code for Teams seats.
- **Rationale:**
  - A tier is unenforceable under MIT and unmeasurable without telemetry.
  - It's aimed at the buyer least likely to pay.
  - Dormant code "invites the assumption that it is wired up."
- **Consequences:** Revenue must come from organisations (D-03) or services.
- **Evidence:** `docs/MONETISATION.md`; `docs/LAUNCH-READINESS.md` D1; `CHANGELOG.md` 1.14.0 "Removed".

<a id="d-03"></a>
**D-03 · Teams as a separate proprietary server**
- **Rationale:** "The thing an individual developer will never pay for — something watching what their agents do — is exactly what an organisation will pay for."
- **Privacy boundary:** only governance metadata goes to the employer's own server; code and prompts never do.
- **Increments:**
  - 0: signed report (built);
  - 1: reporting client (built);
  - 2: the server (not built).
- **Recommended order in the same document:** design partners **before** Teams.
- **Evidence:** `docs/TEAMS-SPEC.md`, `docs/MONETISATION.md`.

<a id="d-04"></a>
**D-04 · Govern only what Solix launched**
- **Rationale:** "Solix governs an agent by setting its environment before it starts, and it never started that one" (`README.md`). Opt-in with `SOLIX_GATE_ENABLED=1`.
- **Consequence:** Marketing must never say "governs all your agents" ([R-04](09-risks-and-technical-debt.md#r-04)).

<a id="d-05"></a>
**D-05 · The claims ledger**
- **Context:** Sixteen defects shared one shape, an **overclaim**: the product said it did X and did X-minus-something.
- **Decision:** Every public promise gets a `CLAIM-*` ID bound to one test file whose source contains the ID. `pnpm claims:check` enforces the manifest, and CI's publish step checks it.
- **Consequences:**
  - Trust is high.
  - Marketing copy costs a test.
  - Stale claim **text** can still drift ([R-17](09-risks-and-technical-debt.md#r-17)).
- **Evidence:** `docs/CLAIMS.md`, `scripts/emit-claims.mjs`, `packages/server/src/claims.test.ts`.

<a id="d-06"></a>
**D-06 · The floor at every level**
- **Context:** In 1.18.0, "the floor moved with the dial": the denylist didn't apply at `observe`, or to sessions with no role or an unknown id.
- **Decision:** The denylist runs for everything that reaches the gate, before rules and levels.
- **Evidence:** `CHANGELOG.md` 1.18.0; `containment.ts` comment; `CLAIM-FLOOR-ALL-LEVELS`, `CLAIM-FLOOR-NO-SESSION`.

<a id="d-07"></a>
**D-07 · Team daily use as the goal; blockers first**
- **Context:** An adversarial evaluation using the "Paperclip method" rated Solix **PILOT**:
  - every tool call was held at `standard`;
  - a deny didn't stick;
  - the `Host` header wasn't validated;
  - parallel dispatch was unwired;
  - two published numbers were wrong.
- **Decision (owner):**
  - "As a team" means an engineering team and its agents run under Solix every day.
  - The blockers get fixed before any adoption push.
  - Three releases (1.19 blockers, 1.20 team-grade, 1.21 adoption).
  - Each is measured with the same eval harness.
- **Evidence:** the 1.19/1.20 content in `CHANGELOG.md`, `docs/EVAL.md`, PR descriptions #42–#55. **The plan itself isn't in the repository** ([Q-03](#q-03)).

<a id="d-08"></a>
**D-08 · Opt-in rules, labelled separately**
- **Rationale:** A rule firing 100 times must not read as 100 human decisions in a signed ledger (`CLAIM-AUTO-DECISIONS-LABELLED`).
- **Rationale for opt-in:** behaviour at the gate doesn't change until a person chooses rules.

<a id="d-09"></a>
**D-09 · Verified terms are frozen**
- **Rationale:** "Verified against its acceptance criteria would stop meaning anything if the criteria could move afterwards" (`docs/PARTNER-BRIEF.md`; `CLAIM-VERIFIED-TERMS-FIXED`).

<a id="d-10"></a>
**D-10 · Rules are not a sandbox**
- **Context:** Three bypass classes were found and fixed on 2026-11-03.
- **Decision:** Harden the matcher. State the limits in `docs/THREAT-MODEL.md`. Point hard isolation to containers or `SOLIX_SANDBOX_CMD`.
- **Consequence:** The pitch is "asks before…", not "isolates…".

<a id="d-11"></a>
**D-11 · Skip 1.19.0**
- **Context:** The 1.19 work was gated on an eval re-measure that hadn't happened. Then 1.20 work landed.
- **Decision:** Ship everything as 1.20.0 and say plainly that 1.19.0 doesn't exist.
- **Evidence:** `CHANGELOG.md`, `docs/releases/v1.20.0.md`.

<a id="d-12"></a>
**D-12 · Headless refuses at once**
- **Rationale:** In CI nobody answers, so a hold would just stall each call for the 300 s timeout and then deny anyway.
- **Evidence:** `docs/GATE.md`.

<a id="d-13"></a>
**D-13 · Parallelism only for isolated tasks**
- **Rationale:** Tasks share one checkout. Parallel writes would corrupt the review surface.
- **Deferred:** dependency-chain parallelism; automatic conflict resolution.
- **Evidence:** `CHANGELOG.md` 1.20.0; `CLAIM-PARALLEL-INTEGRATES`.

<a id="d-14"></a>
**D-14 · Keep `node -e` allowed**
- **Rationale:** "It reaches no further than `node file.js` after a `Write` inside the project, which the defaults also allow. We kept it rather than pretend the difference is a boundary" (`docs/THREAT-MODEL.md`).

<a id="d-15"></a>
**D-15 · No native Windows**
- **Rationale:** The hooks are POSIX shell scripts (`README.md`).
- **History:** Raised as an open fork in `docs/LAUNCH-READINESS.md` D2. Resolved as "state it plainly", not as "support it" ([Q-05](#q-05)).

<a id="d-16"></a>
**D-16 · Model choices.** `orchestrator/index.ts` uses `opus` for the planner and `haiku` for the verifier. **Rationale unknown.** Cost is the obvious lever ([R-21](09-risks-and-technical-debt.md#r-21)).

<a id="d-17"></a>
**D-17 · The galaxy metaphor.** It has been present since v1, and the brand is built on it. **No recorded rationale.** The 2026-11 pitch decision puts "gate first, galaxy as the view".

</details>

---

## Part 2 · Open questions

Prioritised for the incoming PM. **None of these can be answered from the repository.**

| ID | Question | Priority |
|---|---|---|
| Q-01 | Who uses Solix today? | **P0** |
| Q-02 | Which business path comes first? Is GitHub Sponsors on? | **P0** |
| Q-03 | Is the working-session roadmap the approved plan? | **P0** |
| Q-04 | Did any design partner receive the brief, and are they using it? | P1 |
| Q-05 | Will native Windows ever be supported? | P2 |
| Q-06 | Where is the website, and who can deploy it? | P1 |
| Q-07 | Which CI providers must `solix gate` support? | P1 |
| Q-08 | What is the minimum supported Claude Code version? | P1 |
| Q-09 | Keep or remove the galaxy registry? | P3 |
| Q-10 | Has there been an external security review? How should vulnerabilities be reported? | **P0** |
| Q-11 | What is the data-retention and prompt-storage policy? | P2 |
| Q-12 | Are `/api/missions` and `/api/impact` meant to have a UI? | P3 |
| Q-13 | Do the 8 stale branches contain anything to keep? | P3 |
| Q-14 | Would an opt-in update check be compatible with "no telemetry"? | P1 |
| Q-15 | Should more tools (`WebFetch`, MCP) pass through the gate? | P2 |
| Q-16 | Should verification be optional or cheaper? | P2 |

<a id="q-01"></a>
**Q-01 · Who uses Solix today?**
- **Why it matters:** Every prioritisation decision.
- **Context:** No telemetry, 0 issues; npm downloads are the only public signal.
- **If unresolved:** The roadmap stays builder-driven.
- **Ask:** the repository owner; check npm download stats.

<a id="q-02"></a>
**Q-02 · Business path.**
- **Context:** `MONETISATION.md` ranks Teams (#1, "the business"), the compliance pack (#2, "ship this first") and design partners (#3, "do this before either"). Its ordering is self-contradictory on purpose: value versus sequence.
- **If unresolved:** Teams might be built without evidence.
- **Ask:** the owner.

<a id="q-03"></a>
**Q-03 · Is the working-session roadmap approved?**
- **Context:** The launch gates and the 1.20/1.21 roadmap were agreed in AI-assisted working sessions and live in PR descriptions and session records, not in `docs/`.
- **Recommend:** Commit an approved `docs/ROADMAP.md`.
- **Ask:** the owner.

<a id="q-04"></a>
**Q-04 · Design partners.**
- **Context:** `docs/PARTNER-BRIEF.md` was written for 1.18.3. Earlier records mention a draft prepared without an addressee.
- **Ask:** the owner.

<a id="q-05"></a>
**Q-05 · Native Windows.**
- **Context:** WSL works. Native would need non-POSIX hooks.
- **If unresolved:** Windows-first teams can't adopt.
- **Ask:** the owner, informed by partner demand.

<a id="q-06"></a>
**Q-06 · The website.**
- **Context:** It's outside this repository. Earlier deploys were blocked on a Cloudflare credential.
- **If unresolved:** Launch gate 4 is blocked ([B-14](08-backlog-and-roadmap.md#b-14)).
- **Ask:** the owner.

<a id="q-07"></a>
**Q-07 · CI providers.**
- **Context:** Verified on a laptop only. `docs/GATE.md` shows a GitHub Actions snippet that hasn't been run there.
- **Ask:** the owner and partners.

<a id="q-08"></a>
**Q-08 · Minimum Claude Code version.**
- **Context:** The last manual run used `claude` 2.1.316. Agent View needs 2.1.139+.
- **If unresolved:** Support questions can't be answered.
- **Ask:** engineering.

<a id="q-09"></a>
**Q-09 · The galaxy registry.**
- **Context:** The server and CLI exist; there is no UI and no known service.
- **Ask:** the owner.

<a id="q-10"></a>
**Q-10 · External security review and disclosure.**
- **Context:**
  - No external review is recorded.
  - Three rule bypasses were found internally in one day.
  - `SECURITY.md` asks reporters to open a **public** GitHub issue (or "contact the maintainer privately" with no channel given), which is not a safe channel for a vulnerability.
- **If unresolved:** The trust pitch is unbacked, and a vulnerability could be disclosed publicly.
- **Ask:** the owner. Consider GitHub private vulnerability reporting.

<a id="q-11"></a>
**Q-11 · Data retention and prompt storage.**
- **Context:** Prompt text, commands and paths are stored locally and indefinitely.
- **Ask:** the owner (privacy stance).

<a id="q-12"></a>
**Q-12 · Missions and impact APIs.**
- **Context:** They're served but not called by the UI.
- **Ask:** engineering.

<a id="q-13"></a>
**Q-13 · Stale branches.**
- **Context:** Last touched between May and Sep 2026.
- **Ask:** the owner.

<a id="q-14"></a>
**Q-14 · An opt-in update check.**
- **Context:** Users don't learn about security releases ([R-07](09-risks-and-technical-debt.md#r-07)).
- **Ask:** the owner. It's a promise-level decision.

<a id="q-15"></a>
**Q-15 · Gate more tools?**
- **Context:** [R-18](09-risks-and-technical-debt.md#r-18). The trade-off is more holds against more coverage.
- **Ask:** the owner and engineering.

<a id="q-16"></a>
**Q-16 · Cheaper or optional verification.**
- **Context:** About 3× the cost of plain Claude Code; the ≤$4 target was missed.
- **Ask:** the owner.
