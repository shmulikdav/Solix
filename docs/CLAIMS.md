# Claims

Every public promise Solix makes, with the test that fails when it stops
being true.

## Why this exists

Thirteen defects now, and they are all the same shape — not a crash, an
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
| `CLAIM-RENDERER-RELEASES-GPU` | The galaxy can be left running. It builds one shader material per planet and disposes it, and a store event only re-renders the parts whose data changed. | brief ("would you leave it running?"), site (the galaxy itself) | `packages/web/src/scene/atmosphereRim.test.tsx` |
| `CLAIM-LEDGER-COUNTS-EVERYTHING` | `solix ledger`, its exports and the signed fleet report count every decision in the window, and say so plainly when they are listing fewer than they counted. | `solix ledger`, `--md`/`--csv` exports, the fleet report | `packages/server/src/state/ledger.test.ts` |
| `CLAIM-CONTEXT-IS-MEASURED` | The context percentage is measured from the transcript and written down. Where nothing has measured it, Solix says so instead of showing 0%, and never advises `/compact` on a reading it does not have. | site ("every number is live and local"), Mission Control, the advisor envelope, `solix doctor` | `packages/server/src/state/context.measured.test.ts` |
| `CLAIM-ROUTINE-EDIT-KEEPS-HISTORY` | Editing a routine keeps its run history and its webhook URL. A routine's cadence can be corrected; its trigger cannot be changed, and a generic edit cannot enable it. | brief, Routines tab, CHANGELOG 1.18.3 | `packages/server/src/http.routineedit.test.ts` |

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

- budgets pause a plan before it crosses its cap — tested, not yet bound
- secrets are write-only and encrypted at rest — tested, not yet bound
- the Agent View mirror reports real sessions (`agentview.ts`, 328 lines, no
  test)
- `solix gain` and `solix ledger` arithmetic (`gain.ts`, 152 lines, no test —
  it reads the figures `CLAIM-COST-COUNTED-ONCE` pins, but its own sums are
  unchecked)

## The one this cannot reach

Claims published in the **website repo** (`solixagent`) are not checked from
here, and that is where number 5 and number 6 escaped. `solix run` was
described correctly in this repo and wrongly on the home page for weeks,
because nothing in that repo can see `run.ts`.

Until that is closed, the site is the weakest surface, and the discipline is
manual: when a row here changes, grep the site repo for the claim.
