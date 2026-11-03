# Claims

Every public promise Solix makes, with the test that fails when it stops
being true.

## Why this exists

Sixteen defects now, and they are all the same shape — not a crash, an
**overclaim**: the product said it did X and did X-minus-something.

| | the claim | where it broke |
|---|---|---|
| 1 | the gate holds risky commands | the env never reached the hook on `--port N` |
| 2 | the denylist applies at every level | the floor never reached a session with no role |
| 3 | the floor is a floor | the floor never reached an unknown session id |
| 4 | fail-closed refuses the agent | the refusal never reached it for 300 seconds |
| 5 | the denylist is scoped honestly | the corrected copy never reached the live site |
| 6 | `solix run` is governed | it never was, and two documents said it is |
| 7 | results are verified against their criteria | the criteria could be rewritten afterwards |
| 8 | `solix demo` seeded a galaxy | "seed complete: 30 sessions" printed over writes that were rejected |
| 9 | `solix doctor` tells you if it is running | it looked on 4242 whatever port you started on, and called a healthy server down |
| 10 | recurring spend is controllable here | a mistyped cadence could not be corrected at all |
| 11 | the context figure is live and local | nothing persisted it; `solix demo` was the only thing that ever wrote one |
| 12 | the ledger is the record of what you allowed | it stopped at 1000 rows of any kind, and printed that as the total |
| 13 | you can leave it running | every context update leaked a compiled shader, and re-rendered every planet |
| 14 | the mirror shows your background agents | a failed directory read marked every one of them finished |
| 15 | a routine you switched off is off | the fire route never checked, and said "fired" either way |
| 16 | your spend history is yours | the one-time reset destroyed it with no copy, and said so afterwards |

Every one of them was invisible to a passing unit-test suite, because the
code was right *somewhere* and wrong at the surface a reader meets. Numbers
5 and 6 were not code defects at all: the behaviour was correct and the
sentence describing it was false. No amount of testing the code finds those.

So the rule here is the inverse of ordinary coverage. **A claim may not exist
without a test that fails when it stops being true**, and `claims.test.ts`
enforces that in both directions — a row with no test fails, and a
`CLAIM-` id in a test that is not a row here fails too.

This is not a coverage target. The starter set is deliberately the claims
with a *track record of being false*, plus the load-bearing ones nothing was
watching.

## How to add one

1. Add a row below with a new `CLAIM-` id.
2. Put that id in the `describe()` of the test that holds it.
3. Prove it: break the behaviour and watch *that* test fail.

If you cannot write step 2, you cannot make the claim.

## The ledger

| ID | The claim | Published in | Held by |
|---|---|---|---|
| `CLAIM-GATE-HOLDS-LAUNCHED` | A sensitive call from a task Solix launched is held until a human answers. | README, site, brief, `solix level` | `packages/server/src/launcher.spawnenv.test.ts` |
| `CLAIM-GATE-ANY-PORT` | The gate works on a non-default port. | implied everywhere `--port` is offered | `packages/cli/src/startPort.test.ts` |
| `CLAIM-FLOOR-ALL-LEVELS` | The command denylist refuses at every level, including `observe`, for everything Solix launches. | README, site, `solix level` | `packages/server/src/gate.matrix.test.ts` |
| `CLAIM-FLOOR-NO-SESSION` | The floor applies even when the session row cannot be found. | implied by "floor" | `packages/server/src/floor.unknownsession.test.ts` |
| `CLAIM-FAILCLOSED` | An unreachable gate denies rather than waving the command through. | site, brief, smoke E6 | `packages/server/src/launcher.spawnenv.test.ts` |
| `CLAIM-SHUTDOWN-RELEASES` | Stopping Solix refuses what it is holding and exits, rather than hanging. | brief, smoke E6 | `packages/server/src/create.shutdown.test.ts` |
| `CLAIM-RUN-UNGATED` | `solix run` adds a side channel, **not** governance. | site, brief, README | `packages/cli/src/runUngated.test.ts` |
| `CLAIM-VERIFIED-TERMS-FIXED` | A verified task's acceptance criteria cannot be changed afterwards, and a task cannot be marked done without running. "Verified against its acceptance criteria" means what it says. | site ("verified, not assumed"), Maestro section, brief | `packages/shared/src/planEdit.test.ts` |
| `CLAIM-COST-COUNTED-ONCE` | Every cost and token figure is the sum of the transcript, counted once — it does not grow when Solix restarts. | site ("watch the money", "every number is live and local"), Mission Control, `solix gain`, `solix ledger` | `packages/server/src/state/transcript.cost.test.ts` |
| `CLAIM-NO-TELEMETRY` | Solix never chooses a network destination. Every outbound request goes somewhere the user configured. Nothing is collected and nothing is sent on its own. | site ("100% local", "Zero telemetry"), FAQ, README | `packages/server/src/noTelemetry.test.ts` |
| `CLAIM-WS-ORIGIN` | Only a loopback origin can drive the control plane. | site ("100% local"), FAQ | `packages/server/src/origins.test.ts` |
| `CLAIM-IMPORT-NO-SSRF` | A galaxy manifest URL cannot be turned into a probe of the local network. | implied by "nothing leaves your machine" | `packages/server/src/origins.test.ts` |
| `CLAIM-NOTIFY-ON-HOLD` | You hear about a held decision after you have walked away. | brief step 3, site | `packages/web/src/store/notifyOnHold.test.ts` |
| `CLAIM-UNINSTALL-RESTORES` | `solix uninstall` leaves your Claude config exactly as it found it. | brief, site, install guide | `packages/cli/src/uninstall.test.ts` |
| `CLAIM-INSTALL-NEVER-CLOBBERS` | Install refuses to write a `settings.json` it could not read. | CHANGELOG 1.18.0, release notes | `packages/cli/src/install.test.ts` |
| `CLAIM-TEAMS-IDEMPOTENT` | Installing a team twice does not create its routines twice. | CHANGELOG 1.18.0, release notes | `packages/server/src/teams.idempotent.test.ts` |
| `CLAIM-DEMO-SEEDS-OR-SAYS` | `solix demo` seeds a real galaxy into its own sandbox database and cleans up after itself — and when a seed write is rejected it says how many, instead of printing a summary over them. | brief, README, `docs/CAPTURE.md` | `packages/cli/src/demo.test.ts` |
| `CLAIM-DOCTOR-REPORTS-REAL-STATE` | Every `solix doctor` check can both pass and fail, looks where Solix actually is, and degrades to "unknown" rather than to a verdict when it cannot reach the server. | brief, install guide, three error messages | `packages/cli/src/doctor.test.ts` |
| `CLAIM-DISABLED-MEANS-DISABLED` | A routine switched off does not run, from any surface, and "fired" is only reported when it actually started. | Routines tab, `solix schedules`, the webhook URL | `packages/server/src/http.schedules.test.ts` |
| `CLAIM-BUDGET-PAUSES-BEFORE-THE-CAP` | A plan pauses at or over its budget, not after it. | site, Maestro, brief | `packages/server/src/orchestrator/scheduler.test.ts` |
| `CLAIM-SECRETS-WRITE-ONLY` | Connection secrets are encrypted at rest and never read back out. | Connections tab, site ("100% local") | `packages/server/src/state/connections.test.ts` |
| `CLAIM-RESET-KEEPS-A-COPY` | Solix never destroys recorded history without copying it beside the database first, verifying the copy, and saying where it is before it writes. | 1.18.3 release notes, the startup notice | `packages/server/src/costReset.test.ts` |
| `CLAIM-AGENTVIEW-REPORTS-WHAT-IT-SEES` | The Agent View mirror reports what it read. A state it does not recognise shows as unknown, not idle; a read it could not make never marks a session finished. | brief, the `agent` badge, Mission Control | `packages/server/src/state/agentview.test.ts` |
| `CLAIM-RENDERER-RELEASES-GPU` | The galaxy can be left running. It builds one shader material per planet and disposes it, and a store event only re-renders the parts whose data changed. | brief ("would you leave it running?"), site (the galaxy itself) | `packages/web/src/scene/atmosphereRim.test.tsx` |
| `CLAIM-LEDGER-COUNTS-EVERYTHING` | `solix ledger`, its exports and the signed fleet report count every decision in the window, and say so plainly when they are listing fewer than they counted. | `solix ledger`, `--md`/`--csv` exports, the fleet report | `packages/server/src/state/ledger.test.ts` |
| `CLAIM-CONTEXT-IS-MEASURED` | The context percentage is measured from the transcript and written down. Where nothing has measured it, Solix says so instead of showing 0%, and never advises `/compact` on a reading it does not have. | site ("every number is live and local"), Mission Control, the advisor envelope, `solix doctor` | `packages/server/src/state/context.measured.test.ts` |
| `CLAIM-ROUTINE-EDIT-KEEPS-HISTORY` | Editing a routine keeps its run history and its webhook URL. A routine's cadence can be corrected; its trigger cannot be changed, and a generic edit cannot enable it. | brief, Routines tab, CHANGELOG 1.18.3 | `packages/server/src/http.routineedit.test.ts` |
| `CLAIM-RULES-NEVER-OVERRIDE-FLOOR` | An approval rule is consulted only after the containment floor. No rule, however broad, lets a denylisted command through. | README, `solix rules`, Fleet → Rules | `packages/server/src/router.rules.test.ts` |
| `CLAIM-AUTO-DECISIONS-LABELLED` | A decision made by a rule is recorded as the rule's, never as a person's: the ledger's decision count excludes it and counts it separately. | `solix ledger`, the signed report | `packages/server/src/router.rules.test.ts` |
| `CLAIM-HOST-IS-OURS` | The API and the websocket answer only to a loopback name, a `*.localhost` name, or a name listed in `SOLIX_ALLOWED_HOSTS` — so a DNS-rebinding page cannot read local state as if it were same-origin. | README (security), smoke suite H | `packages/server/src/host.guard.test.ts` |
| `CLAIM-ONE-HOOK-SET` | Solix wires exactly one set of hooks into `settings.json`, whichever `SOLIX_HOME` it was last started from; a second home replaces the first set rather than adding to it, and uninstall removes a set from any home. | `solix doctor`, CHANGELOG 1.20.0, the eval numbers | `packages/cli/src/install.test.ts` |
| `CLAIM-DENY-IS-STICKY` | A command a person denies in a plan is refused for the rest of that plan without asking again, and that automatic refusal is counted apart from a person's decisions. The floor still runs first; a one-off approval is not remembered. | `solix` gate, CHANGELOG 1.20.0 | `packages/server/src/router.sticky.test.ts` |
| `CLAIM-DENY-STOPS-RETRY` | When a person denies a command during a task attempt, the task is escalated for a human at once rather than retried — retrying would re-pose a decision already made. | Maestro, CHANGELOG 1.20.0 | `packages/server/src/orchestrator/sticky.test.ts` |
| `CLAIM-RESTART-PAUSES-ON-HOLD` | A plan whose held decision was dropped when Solix stopped resumes paused on restart, for a person to review, rather than deciding the held command by default. | Maestro, CHANGELOG 1.20.0 | `packages/server/src/orchestrator/sticky.test.ts` |
| `CLAIM-DOWNGRADE-NEEDS-FORCE` | Lowering the governance dial while contained sessions are in flight is refused without `--force`, so a running worker's rules are not changed mid-task by accident. | `solix level`, Fleet → Governance, CHANGELOG 1.20.0 | `packages/server/src/governance.downgrade.test.ts` |
| `CLAIM-PARALLEL-LIMIT-ENFORCED` | A plan dispatches at most `parallelLimit` tasks at once (default 1, serial). Above 1, only isolated tasks — each in its own working directory — are co-dispatched; tasks sharing the plan's checkout stay serial. | Maestro, CHANGELOG 1.20.0 | `packages/server/src/orchestrator/parallel.test.ts` |
| `CLAIM-HOOK-OVERHEAD-BOUNDED` | Every shipped hook time-caps its network call and fails open, so a hook can never hold a tool call beyond its cap (one second for telemetry, the gate timeout for a held decision) nor fail one. | install banner, brief, CHANGELOG 1.20.0 | `packages/cli/src/hookOverhead.test.ts` |
| `CLAIM-SCRATCHPAD-COVERED` | A worker's own session scratchpad is treated as inside its confinement for rule coverage, so default rules decide its scratch commands rather than holding each one. Every other path outside the project root stays held, and the command denylist is untouched. | `solix rules`, CHANGELOG 1.20.0 | `packages/server/src/state/rules.test.ts` |
| `CLAIM-RULES-SEE-REDIRECTS` | A redirect's target is judged as a path: no allow rule covers `echo x >/etc/y`, `>>~/.bashrc`, `2>/etc/x` or `S=x>/etc/y`, with or without a space after the operator. Discarding output (`>/dev/null`, `2>&1`, `>&2`) and redirects inside the project are still covered. | `solix rules`, `solix gate` | `packages/server/src/state/rules.test.ts` |
| `CLAIM-ALLOW-RULES-CONFINED` | An allow rule, prefix or regex, matches the command itself rather than how its output is plumbed (`^npm test$` covers `npm test 2>&1`), and never covers a segment that names a path outside the project. Deny rules match wherever they apply. | `solix rules`, `solix gate` | `packages/server/src/state/rules.test.ts` |
| `CLAIM-RULES-TEST-IS-THE-GATE` | `solix rules test` prints the gate's own verdict (`evaluateRules`) for a command or file call, for shell and file tools and with deny rules present, and names the segment no rule covers. | `solix rules test` | `packages/server/src/state/rules.test.ts` |
| `CLAIM-POLICY-EXTENDS-DEFAULTS` | A `solix gate` policy can extend the default rules with `{ "extends": "defaults", "rules": [...] }`; its deny rules still refuse what the defaults allow, and an unknown `extends` or key is rejected before the agent runs. | `docs/GATE.md`, `solix gate` | `packages/cli/src/gate.test.ts` |
| `CLAIM-PARALLEL-INTEGRATES` | An isolated task runs in its own git worktree, concurrently with its siblings, and its changes are integrated back into the plan's checkout; a task whose changes conflict with another's is escalated to a person, never silently merged, and the checkout is left intact. | Maestro, CHANGELOG 1.20.0 | `packages/server/src/orchestrator/parallel.test.ts` |
| `CLAIM-HEADLESS-FAILS-CLOSED` | Under `solix gate` (a headless server), a call a rule allows proceeds and a call no rule covers is refused immediately — never held — recorded as an automatic decision, not a person's. The denylist still runs first, the level dial cannot wave a call through, and a run with any refusal exits non-zero unless `--allow-denials`. | `solix gate`, docs/GATE.md, CHANGELOG 1.20.0 | `packages/server/src/router.headless.test.ts` |
| `CLAIM-TYPO-NEVER-STARTS` | A first word that is not a `solix` command is refused with a clear error naming it (and the closest command, if near) before anything runs — it never falls through to `start`, so a typo never starts the server or touches `~/.claude`. | `solix --help`, CHANGELOG 1.20.0 | `packages/cli/src/commandGuard.test.ts` |
| `CLAIM-GATE-ONE-HOOK-SET` | Under `solix gate`, only the gate's own hooks reach the gate: for `claude` its port, token and fail-closed policy are set on its hook commands and removed from the agent's environment, so Solix hooks installed globally on the machine cannot also report to it, and each call is decided and counted once. | docs/GATE.md, CHANGELOG 1.20.0 | `packages/cli/src/gate.test.ts` |

## The matrix

`packages/server/src/gate.matrix.test.ts` enumerates the gate's whole
decision surface — every governance level × launch path × command class — and
writes out the expected outcome for each of the thirty cells. All three gate
P0s were *cells nobody had visited* rather than logic anyone could see by
reading the function, so a table is the shape that makes a gap visible: an
untested configuration is a missing row, not an absence of thought.

It is proven against the defects it exists for. Reinstating the role-gated
denylist fails six cells; putting the floor back behind the session lookup
fails three; the four that shipped broken are marked `[was a P0]` in the
output. The port dimension cannot be reached from that layer and is held
next door, on the contained-worker path where the allowlist actually
applies.

## There is no hosted Solix

Worth writing down, because it was asked and the answer was not obvious from
the inside. Solix is three things and none of them is a server anyone
operates:

- **npm** — `@shmulikdav/solix`. The product is the package.
- **the user's machine** — `127.0.0.1:4242`, SQLite at `~/.solix/solix.db`.
  No account, no sign-in, no tenancy.
- **a marketing site**, built and published through Lovable, which knows
  nothing about any install.

Audited rather than assumed: no shipped file names a remote host except
`api.telegram.org`, in the notifier that needs a bot token the user pasted.
Slack's destination is the webhook URL they supplied. `RegistryClient` reads
`SOLIX_REGISTRY_URL` and is inert without it — a client for a service that
was never built, which is why the brief says Share does not share. That is
pinned by `CLAIM-NO-TELEMETRY`.

## Not yet claimed here

Honest gaps, so this file does not read as more complete than it is. These
are published promises with no row yet:

- `solix gain`'s *formatting* (`gain.ts`, 152 lines, no test). The entry
  here used to blame it for "its own sums", which was wrong: it computes
  nothing but a window label — every figure comes from `summarizeImpact`,
  which `CLAIM-COST-COUNTED-ONCE` and `impact.test.ts` now cover. What is
  genuinely unwatched is the rendering, and that is a smaller gap than this
  list implied.

## The one this cannot reach

Claims published in the **website repo** (`solixagent`) are not checked from
here, and that is where number 5 and number 6 escaped. `solix run` was
described correctly in this repo and wrongly on the home page for weeks,
because nothing in that repo can see `run.ts`.

Until that is closed, the site is the weakest surface, and the discipline is
manual: when a row here changes, grep the site repo for the claim.
