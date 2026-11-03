# 02 · Product Vision & Strategy

[← Package index](README.md) · Previous: [01 · Executive summary](01-executive-summary.md) · Next: [03 · Complete PRD](03-complete-prd.md)

This document separates three kinds of statement, and labels each:

- **[Documented]**: written down in the repository, with the source given.
- **[Owner decision]**: agreed by the owner in the 2026-11 working sessions and recorded in PR descriptions, `CHANGELOG.md` or `docs/EVAL.md`.
- **[Inferred]**: read from what the code does, not from anything anyone wrote as strategy. Treat these as hypotheses.

---

## 1. Vision and mission

| | Statement | Label / source |
|---|---|---|
| Tagline | "The control layer for your coding agents — 100% local." | [Documented] `README.md`, `packages/cli/package.json` |
| Promise | "Build with agents that have to ask first." | [Documented] `README.md` |
| Earlier framing | "Air traffic control for AI assistants" | [Documented] `DEMO.md`, from Sep 2026. The framing has since moved from *seeing* to *governing*. |
| The sentence the evidence supports | "It asks before your agent deletes something, refuses when nobody answers, and shows you what it cost." | [Owner decision] Chosen as the pitch for the 1.21 launch, because it is the one claim the adversarial evaluation verified. |
| Long-term goal | "An engineering team and its agents run under Solix every day." | [Owner decision] Agreed Nov 2026 as the meaning of success. See [D-07](10-decisions-and-open-questions.md#d-07). |

**No formal mission statement exists.** [Inferred] The consistent through-line in commits and docs is *trustworthy autonomy*: let agents do more on their own by making their risky moments visible, decidable and recorded.

## 2. User and business problems

| Problem | Who has it | Evidence |
|---|---|---|
| An agent runs a destructive or irreversible command unseen | Any developer running agents | [Documented] `README.md`, `docs/THREAT-MODEL.md` |
| A permission prompt in some terminal is missed and the agent stalls | Developers running several sessions | [Documented] `DEMO_DEV.md` ("lost track of which one's blocked on a permission prompt") |
| Spend is invisible until the bill arrives | Developers and their managers | [Documented] `README.md` (Mission Control), `docs/MONETISATION.md` ("Claude runs $200–800 per developer per month") |
| No proof of what agents were allowed to do | Organisations, auditors | [Documented] `docs/TEAMS-SPEC.md` ("prove no agent ran an unreviewed destructive command last quarter") |
| Agents in CI run either ungated or stalled | Teams automating with agents | [Documented] `docs/GATE.md` |
| Being asked about every single action makes people switch the gate off | Every gate user | [Documented] `docs/EVAL.md`: 30 holds for 30 tool calls on 1.18.3 |

The figures above come from the docs as stated and have not been independently checked. **No customer interviews or user research** exist in the repository.

## 3. Value proposition and positioning

**[Documented] Differentiators the product leans on:**

1. **Local and private.** "No account, no telemetry, nothing leaves your machine." This is enforced by a test (`CLAIM-NO-TELEMETRY`, `packages/server/src/noTelemetry.test.ts`).
2. **A real gate, not a log.** Risky calls are held and refused on failure (`CLAIM-FAILCLOSED`, `CLAIM-GATE-HOLDS-LAUNCHED`).
3. **Honesty as a feature.** Every public claim is bound to a test (`docs/CLAIMS.md`), and release notes state unmeasured numbers as unmeasured.
4. **Free, MIT, no tiers.** [Documented] `docs/MONETISATION.md`, `README.md`.

**[Documented] Competitive references:**
- The evaluation compares Solix against **plain Claude Code** and against **Paperclip**, another agent-orchestration tool (`docs/EVAL.md`). The comparison table is the planned centrepiece of the launch post.
- No other competitive analysis exists in the repository.

**[Inferred] Positioning gap.** The README still opens with the galaxy visual and lists "15 advisors" and "skills" as headline bullets. The owner's chosen pitch puts the **gate first** and the galaxy second. The README and the website have not been rewritten to match ([B-12](08-backlog-and-roadmap.md#b-12)).

## 4. Target market

| Market | Label | Notes |
|---|---|---|
| Individual Claude Code users on macOS / Linux / WSL | [Documented] | Native Windows is unsupported (`README.md`) |
| Engineering teams, including CI | [Owner decision] | 1.20's `solix gate` was built for this |
| Organisations wanting fleet-wide oversight | [Documented] as a future paid product | `docs/TEAMS-SPEC.md` |
| Codex (OpenAI) users | [Documented] as experimental | `docs/multi-runtime.md` |

**Market size, segments and pricing research: none.** The Teams price of "~$25/developer/month" in `docs/MONETISATION.md` is a hypothesis in a decision record, not a validated price.

## 5. Business model

[Documented] `docs/MONETISATION.md`, dated 2026-10-25 and self-described as "a decision record, not a plan of record". It ranks five options:

| Rank | Option | Status today |
|---|---|---|
| 1 | **Solix Teams**: a self-hosted aggregation server the company runs; local Solix reports to it | **Spec only** (`docs/TEAMS-SPEC.md`). Increment 0 (the signed report) and increment 1 (the reporting client) are built; increment 2 (the server) is not |
| 2 | **Compliance pack**: signed, tamper-evident audit plus SIEM export | Signed report **built**; SIEM export **not built** |
| 3 | **Design-partner contracts**: "do this before either of the above" | **Unknown.** A partner brief exists (`docs/PARTNER-BRIEF.md`, written for 1.18.3); whether any partner received it or signed is not recorded |
| 4 | GitHub Sponsors | **Unknown** whether enabled |
| 5 | Individual Pro tier | **Rejected and removed** ([D-02](10-decisions-and-open-questions.md#d-02)) |

**Revenue today: none known.**

## 6. Goals and intended outcomes

| Goal | Measure | Label / source | Status |
|---|---|---|---|
| A hold is the exception, not the rule | **≤3 holds** on the eval task with default rules | [Documented] `docs/EVAL.md` | Last measured: 4. A fix since is unit-tested only, so re-measure ([B-03](08-backlog-and-roadmap.md#b-03)) |
| Solix's overhead is affordable | **Cost ≤$4** on the eval task | [Documented] `docs/EVAL.md` | Last measured: ~$5.45. **Missed** |
| Fast enough | **Wall ≤7 min** | [Documented] | ~4 min. **Met** |
| No babysitting | **0 unplanned interventions** | [Documented] | **Met** |
| Correct result | Tests pass and are committed | [Documented] | **Met** |
| Adoption | Three external teams running it ≥2 weeks; ≥1 externally found gate bug fixed with a claim | [Owner decision], 1.21 roadmap, **not in the repository** | Not started |
| Every public claim is true | Every claim has a test that fails if it breaks | [Documented] `docs/CLAIMS.md` | 48 claims, all passing |

## 7. Scope and boundaries

**In scope:**
- [Documented]
  - observing, gating and costing Claude Code sessions on the local machine;
  - orchestrating multi-agent plans (Maestro);
  - CI gating (`solix gate`);
  - local audit records;
  - opt-in reporting to a company server.

**Explicitly out of scope:**
- [Documented] Being a sandbox. "Rules are standing decisions, not a sandbox" (`docs/THREAT-MODEL.md`). Hard isolation is delegated to containers or `SOLIX_SANDBOX_CMD`.
- [Documented] Gating sessions Solix did not start, unless the user opts in. A `claude` you start yourself is observed, not gated (`README.md`).
- [Documented] Network egress control (`docs/THREAT-MODEL.md`).
- [Documented] Native Windows (`README.md`).
- [Documented] Any cloud service run by Solix. The galaxy registry and reporting endpoints are configured by the user.

## 8. Strategic assumptions

Each of these needs validation.

| # | Assumption | Label | Validation route |
|---|---|---|---|
| A1 | Developers will accept being interrupted if the interruptions are few and specific | [Inferred] from the rules work | Design-partner usage, eval holds |
| A2 | Organisations will pay to watch their own fleets, and individuals won't pay to be watched | [Documented] `docs/MONETISATION.md` | Design-partner conversations ([Q-02](10-decisions-and-open-questions.md#q-02)) |
| A3 | "Local, no telemetry" is a buying reason, not just a nice-to-have | [Inferred] | Ask partners |
| A4 | Claude Code's hook contract (`PreToolUse` → `permissionDecision`) stays stable | [Inferred]; the whole gate depends on it | Track Claude Code releases ([R-08](09-risks-and-technical-debt.md#r-08)) |
| A5 | Claude Code will remain the dominant runtime long enough to matter | [Inferred] | Codex support is a hedge, still experimental |
| A6 | A visual "galaxy" helps rather than distracts | [Inferred]. It is the brand; the owner's pitch demotes it to "the view" | Watch first-run behaviour |
