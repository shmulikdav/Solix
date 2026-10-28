# Changelog

All notable changes to Solix (`@shmulikdav/solix`) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.18.1] — 2026-10-28

**Stopping Solix no longer leaves the agent hanging.**

1.18.0 was walked end to end from the published npm tarball, following
`docs/PARTNER-BRIEF.md` literally, in the order a design partner would read
it. The brief's step 2 is *kill the Solix server mid-hold*, and calls
fail-closed "the property I would not ship without".

Fail-closed held. The canary file survived every run; nothing destructive
ran at any point. Everything around it did not:

- **`Ctrl+C` did not quit while anything was held.** `solix` printed
  `SIGINT — shutting down` and sat there. `http.Server.close()` does not
  call back until every open connection has ended, and a held permission is
  an open HTTP request whose only possible answer is a human in the UI that
  is shutting down with it. So the `await` never returned and the
  `process.exit(0)` after it never ran.
- **The agent waited five minutes to be refused.** The audit log recorded
  the hold opening at 17:01:41 and `Timed out after 300s and was denied` at
  17:06:41 — the gate's own backstop, firing inside a process that could no
  longer exit. `docs/E2E-SMOKE-TEST.md` promised "seconds, not the 305s
  `--max-time` ceiling". It was the ceiling, to the second.
- **An open browser tab did the same thing on its own.** A websocket is a
  socket the HTTP server waits for too, and `closeAllConnections()` cannot
  reach it because Node stops tracking a socket once it has been upgraded.
  Measured: a client with a 20s lifetime held a signalled server up for
  16.2s. With the UI open — the state the brief puts you in — Ctrl+C waited
  on the tab even with nothing held.

Shutdown now records each abandoned hold and drops the sockets. It does not
answer the hook: the hook sees its connection fail and takes its fail-closed
branch, so the agent is refused and told the gate was unavailable rather
than that a person reviewed the command. Nobody reviewed it.

Re-measured against a real agent, with a websocket held open for five
minutes and a permission held: **222ms**, down from 300,000ms.

`createSolixServer` had no test of any kind, which is why this shipped. It
has three now, and each half of the fix was proven by reinstating its own
bug.

Also closed a coverage hole the same walk exposed: nothing asserted that a
`permission_request` arriving over the websocket actually produces a
notification — the brief's step 3, "walk away mid-hold". The notifier and
the opt-in button were both well covered in isolation; the line connecting
them was not, so deleting it broke nothing. Four tests now cover it, and it
was additionally confirmed live in a real browser with notifications
granted and the tab hidden.

## [1.18.0] — 2026-10-28

**An audit, and then two days of finding out the gate was off.**

Solix was first read the way a team evaluating it would read it: every tab
opened, every claim checked against the code. It scored 4/10 — the mechanism
at the centre looked sound, and the layer around it kept reporting things
that were not true.

Then the mechanism itself was run rather than read, against a real `claude`
and with configurations nobody had varied, and it turned out to be off in
three different ways — on a non-default port, for anything that was not a
Maestro worker, and whenever a session row could not be found. Every one of
them was unit-tested and passing throughout.

Both halves are in here, worst first.

### Fixed — three ways the gate was off without saying so

Found by running Suite E against a real `claude` rather than against tests,
and by varying configurations nothing had varied. All three were
unit-tested and passing the whole time.

- **`solix start --port N` disabled the gate entirely.** The hooks are shell
  scripts that locate the server through `SOLIX_PORT`, defaulting to 4242,
  and `buildSpawnEnv` forwards that variable to the agents Solix spawns. The
  flag moved the listener and never set the variable, so every spawned
  agent's hook called 4242, found nothing, and fail-closed on every tool
  call.

  Safe, and useless: the agent was *blocked* rather than held, no decision
  card ever appeared, and the only trace was "Solix gate unavailable
  (fail-closed)" inside a worker's report. Worse, the port-conflict message
  added in this same release tells you to `--port` your way out of a
  collision — straight into it.

- **The floor was evaluated behind a database lookup.** `requestPermission`
  called containment only inside `if (session)`, so a tool call whose
  session row could not be found skipped the denylist and fell through to
  the dial: at `observe` a denylisted command under an unknown session id
  returned `{"decision":"allow"}`, and at `standard` and `strict` it was
  merely *held for a human*. A session row is absent for ordinary reasons —
  a tool hook arriving before `session-start` is processed, a pre-created
  planet row that failed to write, a correlation miss.

- **Suite E now passes against a real agent**, including the fail-closed
  case, and `docs/E2E-SMOKE-TEST.md` gains **F8**: run the denylist probe at
  all three levels every release. It had no live coverage at all before
  this. Worktrees were checked at the same time and are correct; Codex has
  no gate and the multi-runtime doc now says so.

### Fixed — a second team install doubled the bill

- **Installing a team twice created its routines twice.** A team's routines
  are recurring spend: each starts a real agent session on a cadence and
  bills on every run. `installTeamTemplate` called `createSchedule`
  unconditionally with no idempotency check, and the success toast was
  identical both times — so a second click, which nothing discouraged
  because nothing said the first had worked, left two enabled routines
  running the same prompt forever. They are recognised by project +
  template + name now, and reported rather than duplicated.

- **The install failure reason was discarded.** The server returns it in
  `warnings`; the store kept only `ok` and `warnings` and never set `error`,
  so every cause rendered the same bare "Install failed." On success,
  warnings collapsed to "(1 skipped)".

- **One checkbox answered for every team.** `includeRoutines` was a single
  tab-level boolean rendered inside the template list, so declining routines
  on one card declined them on all — on the control that decides whether
  recurring spend starts.

### Fixed — surfaces that failed in silence

- **Connections could not tell you when a write failed.** Six
  `fetch(...).catch(() => {})` with no status check, in a credential store
  whose secret values are write-only — so a failed write was both invisible
  and unrecoverable. The `Test` button rendered no result either way,
  despite the server computing one, which hid the dangerous case: a webhook
  that rejected the message, so the credential is wrong and you believe it
  works.

- **A list that failed to load rendered as "you have none."** In
  Connections, Teams and Crew alike. "You have none" and "I could not ask"
  are different facts, and guessing wrong sends people to create something
  they already have.

- **Maestro could not retry a task or delete a plan**, while the endpoints
  for both shipped uncalled. A failed plan was terminal, so the only route
  back was a follow-up *goal* — a new plan with new planner spend that
  abandons the task state.

- **"Review changes" could show your own uncommitted work as the fleet's.**
  With no captured base commit the diff fell back to `HEAD`, silently. It
  says so now, and names the base when it has one.

- **"Open preview" was offered where it could not work**, including for Node
  and Python projects, in a chromeless popup landing on an HTTP 200 dead
  end.

### Fixed — the floor moved with the dial

- **The command denylist only ever guarded Maestro's agents.**
  `evaluateContainment` opened with
  `if (!isContainedRole(role)) return { blocked: false }`, so `rm -rf /`, a
  fork bomb and `curl | sh` were refused for workers, verifiers and routines
  — and nothing else. A **New task** you launch from the UI carries no role,
  so at `observe` it ran unimpeded, and at `standard` it was *held for a
  human*: a different mechanism, with a different promise.

  Meanwhile the README said the denylist is "not on that dial — refused at
  every level, including `observe`, in every one of those rows", and the
  text shown when you select a level said "the command denylist still
  blocks". Confirmed against a real agent: a New task ran `sudo -n true` at
  `observe` with nothing in its way.

  The denylist now runs for anything that reaches the gate. Confinement to
  the project directory stays role-scoped, deliberately — that exists so an
  unwatched worker cannot wander out of its project, while a New task is you
  in your own environment.

- **The gate was not injected at `observe` at all**, which is why there was
  nothing to run the denylist. `SOLIX_GATE_ENABLED` is the only way the hook
  reaches the server, and the server is the only place containment runs.
  It is now injected at every level, with the policy carrying the
  difference: `fail-open` at `observe`, so the floor holds while Solix is up
  and a dead Solix never blocks a task on the setting that means "stay out
  of my way"; `deny` above it, where a human is meant to be deciding.

- **The claim is narrower and now true.** A `claude` session you started
  yourself is governed by nothing, and cannot be — Solix governs an agent by
  setting its environment before it starts. The README, the level
  description and the website say that instead of implying otherwise;
  `solix run` is the way in.

### Fixed — it could lose data that is not Solix's

- **A malformed `~/.claude/settings.json` was replaced with Solix's hooks
  alone.** `readSettings` returned `{}` on a parse failure and that `{}`
  went straight into `{ ...existing, hooks: merged }` and back to disk — so
  one trailing comma or `//` comment in your settings discarded your
  `permissions`, `env`, `model`, `apiKeyHelper`, `statusLine` and MCP
  servers, and then printed *"merged hooks into …"* as though it had merged.
  The only warning was a `console.warn` third in a wall of sixteen identical
  `[solix]` lines.

  `uninstall.ts` had already argued the general case and got it right:
  *"uninstalling a tool is not consent to roll back a config file the tool
  does not own"*. Neither is installing one. Install now refuses to write a
  file it could not read, and says what it did not do.

- **The backup covered exactly one write, and `--force` destroyed it.** It is
  taken once and never refreshed, and `--force` — which means "re-install
  the hooks" — overwrote it with a file Solix had already written, losing
  the only copy of your pre-Solix settings, which is the copy `uninstall`
  restores. `--force` no longer touches it, and every write is now preceded
  by a rolling `settings.solix.prev.json`.

- **Your own agents in `~/.claude/agents` were overwritten without a
  backup.** Fifteen advisor files were copied in with an unconditional
  `copyFileSync` — no existence check, no backup, no mention beyond
  *"installed 15 advisor agents"* — so an agent you wrote called `forge.md`
  was simply gone. Colliding files are kept as `<name>.md.pre-solix.bak`
  and the collision is named in the output.

- **`solix uninstall` left them all behind**, which made first run's *"undo
  any time with `solix uninstall`"* untrue: unregistering the hooks left
  fifteen agent definitions in every future Claude Code session. It now
  removes what it installed — by name, from a manifest, so an agent of
  yours with a colliding name is not collateral — and restores one it
  displaced. Your database stays: it holds your session and cost history,
  and deleting that to uninstall a wrapper would be its own data-loss bug.

### Fixed — the core loop could not confirm itself

- **An approval could vanish and leave the agent blocked forever.** The
  websocket `send` was `if (socket && readyState === OPEN) { … }` — no else,
  no queue, no return value — so every caller assumed success. The socket
  drops on any server restart, which is every upgrade. `resolvePermission`
  then deleted its own card immediately, so a dropped approval cleared the
  card and the "needs you" badge and left the agent waiting on a decision
  you watched disappear. New Task cleared your prompt and closed; a chat
  prompt was appended to the transcript and never answered.

- **There was no acknowledgement to wait for.** `permission_resolved` did
  not exist anywhere in the codebase. The server never announced a
  resolution, so a second tab kept a live card whose buttons did nothing,
  and the 300-second gate timeout denied in **total silence** — no audit
  row, no toast, the card still on screen and still counted. `timedOut` was
  computed and shown to nobody.

  `send` now reports whether the message left. Nothing is treated as done
  until the server says so, the card stays up showing why, and the timeout
  says the agent was refused rather than left waiting.

- **Terminate did nothing.** `terminate_session` was a bare `break;` under a
  comment claiming it marked the row terminated — it did not do even that.
  The danger-red button, on a list with select-all, cleared the selection
  and left every process running. It signals the process now, and for a
  session Solix did not start it says so plainly instead of clearing the
  planet and implying a kill.

- **You were never told an agent was waiting.** OS notification permission
  was requested lazily inside `notify()`, and all three callers pass
  `whenHidden: true` — so the only moment it asked was while the tab was
  hidden, which is the one moment browsers refuse to prompt. The file's own
  header admitted it: *"it's a no-op if the user never has the tab in the
  background"*. There was no gesture-driven path anywhere. The top bar now
  has one, and says when the browser is blocking them.

### Fixed — first run

- **`solix demo` seeded nothing, and said it had.** It read the server token
  at module load — before the server it spawns creates it — so on a machine
  where Solix had never run, every event POST came back 401, and the seeder
  never checked. It printed *"seed complete: 30 sessions across 8 projects"*
  over an empty database, on exactly the clean machine where someone tries
  it first. The demo is what the README, the welcome modal and every empty
  state point at.

- **A port already in use crashed after claiming success.** `serve()`
  returns synchronously and attaches no error handler, so Solix printed
  *"server listening on http://127.0.0.1:4242"*, opened a browser at
  whatever was already there, and died with an unhandled `EADDRINUSE` stack
  trace. It now reports the conflict and the port to try next. `solix demo`
  had handled this correctly since it shipped.

- **`?` then `Escape` destroyed the onboarding permanently.** The keymap had
  no modal guard, so `?` — which the welcome modal's own footer tells you to
  press — opened Help on top of it, and the single Escape that closed Help
  also burned the first-run flag. No reset existed anywhere; DevTools was
  the only recovery. The keymap is now inert while the modal is up, and Help
  has **"Show the welcome again"**.

- **`solix doctor` was red on a healthy machine.** It failed *"Backup of
  settings.json"* on a clean install, where no backup exists because there
  was nothing to back up, set exit 1, and told you to run `solix install`,
  which could never produce one. A check permanently red on a healthy
  machine teaches people to ignore checks. A second check was
  `ok: skillCount >= 0` on a `.length` — it could not fail, so it reported
  health it had never established.

- **The galaxy did not move.** Orbital motion defaulted to off, so the
  flagship orbiting scene was a still image on first load — and the key that
  starts it, Space, was the one the keymap hijacked. It defaults on now,
  unless your OS asks for reduced motion, and Space no longer fires while a
  button has focus.

- **`SOLIX_PORT` was dead.** A commander default of 4242 always beat it.

### Fixed — figures nobody had measured

- **A cadence typo billed 168× what the UI promised.** Nothing validated the
  string, and anything unparseable was parked one hour out. `1w` — plausible
  given the `30m / 2h / 1d` placeholder — produced a routine whose warning
  said *"every 1w"*, whose card said *"every 1w"*, and which fired hourly
  forever. With no `PATCH` for a routine it could not be corrected, only
  deleted, losing its run history and rotating its webhook token. Both the
  route and the form now refuse it and name the valid forms, 7d included.

- **Mission Control reported three figures it did not have**, in a panel
  whose docstring claims *"All figures are real"*. `Cost / mission` read
  `$0.00` whenever nothing had completed — beside a Total spend tile showing
  real money, so the panel contradicted itself in adjacent tiles. Context
  pressure read `avg 0% · max 0%` on a fresh install, which is a measurement
  claim about data that does not exist. Interventions summed three unlimited
  audit fetches by `.length` against a 200-row cap, so it counted three
  pages and stopped at 600 forever.

- **The advisor roster said four different things at once** — 15 in the
  manifest and the install log, "Fourteen" in the welcome modal, 14 in the
  README, "5 active · 10 available" in Crew. The modal derives it now.

- **Three helpers were applied only where someone happened to be looking.**
  `expandHome` guarded seven HTTP routes but not the websocket launch path,
  which is the one the New Task modal uses — so typing `~/project` still
  failed after the tilde fix shipped. The preflight check hardcoded
  `spawnSync('claude')`, ignoring `SOLIX_CLAUDE_BIN`, the documented nvm
  escape hatch — and then disabled the Launch button on its own result.
  `explainSpawnError` existed while the synchronous `catch` beside it
  hardcoded *"claude binary not found"* for any throw, including a
  non-executable shim.

### Added

- **`solix start --no-wire`**, and first run now says what it is about to
  write **before** writing it — including that two hooks run in the blocking
  path of every tool call of every Claude Code session on the machine. The
  two actionable lines of sixteen now print before the browser steals focus,
  instead of scrolling past behind it.
- **A `DEMO DATA` badge.** `solix demo` was pixel-identical to real data,
  with list-price dollar figures and a `rm -rf node_modules` prompt every 75
  seconds, in a product that sells cost governance.
- **Errors are announced.** Toasts had no `aria-live`, no role and no icon,
  and distinguished error from warning by hue alone — invisible to a screen
  reader, ambiguous to a colour-blind user, gone in five seconds.
- **The List works without a mouse.** Opening an agent was a bare `onClick`
  on a `<tr>`; eight of eleven sortable headers had no `aria-sort`, and the
  `●` column had no accessible name. Pinch-zoom works again
  (`maximum-scale=1.0` was a WCAG 1.4.4 failure in a UI with 9px text).
- **Collapse a project group in the List view.** With hundreds of agents
  across a dozen projects, the List had the same scaling problem the galaxy
  does. The choice is remembered, and it stores the *collapsed* set rather
  than the expanded one, so a project discovered later shows up open instead
  of hidden behind a click nobody knows to make. A collapsed header still
  shows the project, its agent count, and **"N needs you"** when any of its
  agents is holding a command — putting noise away must not put the signal
  away with it.

### Changed

- **The List's Health score is a word now.** It read 85 for every idle agent,
  which was the formula's honest answer — the `progress` band was only
  awarded for an active mission, so an idle agent could never earn it and 85
  was the ceiling. Rescaling it so a healthy agent read 100 fixed the
  arithmetic and not the problem: a number blending *"will start forgetting
  soon"* with *"is blocked waiting on you"* cannot be acted on, and nobody
  could say why an agent was 70 rather than 65. A terminated agent scored 80
  and showed green, which made it plain — a finished agent is not healthy, it
  is not anything.

  The column is now **Attention**, and says the one thing worth doing:
  `3 commands waiting on you`, `Context at 92% — compact…`, `Done`, or a
  dash. **A dash is the common case and the point** — with hundreds of idle
  sessions, a column that says something on every row says nothing.

### Removed

- **`health.ts`, a second scoring system.** It consumed the same three
  signals as `suggestForSession` — status, context pressure, held commands —
  and the List rendered one while the SidePanel rendered the other, so the
  two could disagree about the same agent. The score also recombined three
  columns already on the row: Status, Context % (same thresholds, its own
  bar, one cell away and moving in step), and the needs-attention dot. It
  added no fact, only arithmetic.

  `suggestForSession` gained the held-command case and is now the single
  source for the List column, the 3D planet label, and the SidePanel banner.
  The planet's atmosphere glow, the only continuous consumer, is driven by
  context headroom — the term that dominated the score anyway — so it still
  dims as an agent fills up, from one honest input.

## [1.17.0] — 2026-10-27

**Every way Solix launches an agent is now governed.**

### Changed

- **A New task is gated now.** It was the most prominent button in the UI and
  the only launch path Solix never governed — it carried no
  `SOLIX_GATE_ENABLED` at any level, so its hook never blocked and no decision
  was ever raised. At `standard` and `strict` its risky commands are held like
  anything else Solix launches; `observe` still holds nothing, which is what
  `observe` means.

  It is **gated without being contained**. Containment bundles two things —
  strip the env to an allowlist, and inject the gate. That bundle is right for
  an autonomous worker nobody is watching. It is wrong for a task you launched
  and are sitting in front of: scrubbing would take away the keys and tooling
  your own shell has, to protect you from yourself. Your environment, held
  commands.

  **Agent View is skipped for a gated launch**, and says so. `claude --bg`
  hands the session to a supervisor that does not inherit our env when it is
  already running, so the gate would apply or not depending on whether
  something else happened to start the daemon first. A guarantee that holds
  nondeterministically is worse than one that is plainly absent.

### Added

- **A test that reads the env off the spawn itself.** With the env builder
  tested and the Agent View decision tested, the fix could still be deleted
  and every test passed — confirmed by reverting it. That is the shape of
  every gate bug in this project: the layer below is right, the layer above is
  right, and nothing checks the wire between them. `launcher.spawnenv.test.ts`
  intercepts `spawn` and asserts the child really carries the gate.

## [1.16.0] — 2026-10-27

**Three things found by watching someone use the gate for the first time.**

Suite E passed on 1.15.0 — a worker was held, denied, and the canary survived.
These are what the passing run exposed on the way past.

### Fixed

- **A denial told the agent nothing, so it tried again in different words.**
  Denied `rm -rf ./canary`, it came back with
  `rm ./canary/keep.txt && rmdir ./canary`, three times. Each retry is another
  card for a person to read, and the fourth gets approved out of fatigue.
  `permissionDecisionReason` — the only channel back to the model — said
  "Denied in Solix", which reads like a transient obstacle. It now says a
  person reviewed this exact command and decided, that it is not a transient
  failure, and not to reword it.

- **The destructive-command hint only matched the obvious spelling.** It
  tested for `rm -rf` and `sudo`, so the reworded deletion above drew no
  warning at all — and the rephrased form is the one a tired reviewer waves
  through. `isDestructive` now covers any `rm`, `rmdir`, `git clean`,
  `git reset --hard`, branch deletes, `shred`, `truncate`, `dd of=`,
  `find -delete`, docker teardown and truncating redirects. 36 tests, half of
  them ordinary commands that must stay quiet.

- **"2 need you" that opened an empty panel.** Pending requests live in
  memory and session status lives in SQLite, so a restart left rows marked
  `awaiting_permission` with nothing behind them — permanently. The badge sat
  on a stale count all day while Decisions correctly said "Nothing waiting",
  and the natural conclusion was that Decisions was broken. The router now
  clears those holds at construction, before any hook can arrive, and tells
  connected browsers.

### Added

- **A guard for the hook payloads.** Every JSON object the hooks emit is
  wrapped in shell single quotes, so one apostrophe inside terminates the
  string and the hook emits garbage. Writing "the reviewer's attention" into
  the new deny reason broke all three hooks at once, and the only symptom was
  five unrelated tests failing on a JSON parse. The contract test now asserts
  each payload is apostrophe-free and parses, naming the file that broke.

## [1.15.0] — 2026-10-27

**The gate actually holds now.**

Suite E was run against a real agent for the first time and failed: a Maestro
worker ran `rm -rf` on a canary directory, the verifier certified it, and
nobody was ever asked — while the front page promised the command would be
held. This release makes the promise true, and narrows it where it was never
true at all.

### Fixed

- **The approval gate never fired at the default level.** A Maestro worker ran
  `rm -rf /Users/…/solix-qa/canary` on a real machine, the verifier certified
  it, and nobody was asked — while the front page promised the command would
  be held. `shouldGateContainedRole` returned true only for `strict`, and
  contained roles are the *only* sessions carrying the gate env, so at
  `standard` the human gate was unreachable code.

  `governance.ts`'s own description of `standard` always read *"sensitive
  calls from a task Solix launched are held"*. The contract was right; the
  implementation never kept it.

  **A worker or verifier is now held at `standard`** — it runs from a plan you
  just approved and are watching, so there is someone to ask. **A routine is
  not**, because it fires on a schedule with nobody at the keyboard: holding
  one would stall until the gate timed out and then deny, turning every
  unattended run into a silent failure. `strict` holds routines too.

  Two tests asserted the old behaviour and now assert the new one. They are
  the reason this shipped three times.

- **`~` was never expanded in a project path.** `~/solix-qa` reached
  `spawn({ cwd })` literally, and Node reports a missing cwd as
  `spawn claude ENOENT` — naming the command, so it read as a broken Claude
  Code install. `expandHome()` now runs at every point a cwd enters the API,
  and `explainSpawnError()` checks whether the directory exists before
  blaming the binary.

### Changed

- **The gate's scope is stated honestly** in the README, on the website and in
  `docs/E2E-SMOKE-TEST.md`. A **New task** launched from the UI is *not*
  gated — it carries no gate env at any level and keeps Claude Code's own
  prompt. The smoke-test doc had listed it as gated, which is why Suite E was
  run against a path with no gate and appeared to find a UI fault instead.

## [1.14.0] — 2026-10-26

**Free and MIT, all of it — and the evidence to prove it was worth it.**

The Pro tier is gone, because it was unenforceable under MIT, unmeterable
without telemetry, and throttling the wrong person. In its place: two ways to
show what the governance actually prevented, one for a single machine and one
for a fleet.

> **A minor version for a removal.** `solix license`,
> `/api/system/entitlement` and `/api/license/activate` are gone, which is
> strictly a breaking change. They are treated as a minor here because no key
> could ever verify against them — `PUBLIC_KEY_PEM` was `null` — so nothing
> that worked has stopped working.

### Added

- **`solix reporting`** — send decisions to a server your company runs.
  Increment 1 of Solix Teams, and **off until you turn it on**: with no
  endpoint configured there is no network call, ever.

  `enable` takes an `https://` URL or `file:/abs/path.jsonl`, so a pilot runs
  with no server at all. `preview` prints the exact body and sends nothing.
  `--redact` swaps commands for fingerprints. `status` says where it goes and
  what is queued; `disable` stops it and keeps the endpoint.

  What crosses the wire is fixed and narrow: decisions, containment blocks and
  spend. **Prompts, model output, diffs and file contents never do** — there
  is no code path that reads them, and a test asserts the record shape so a
  future field cannot widen it quietly.

  The queue is the audit log itself, drained from the old end with a
  high-water cursor. A failed send leaves the cursor untouched, so nothing is
  lost; a re-send is a duplicate the server ignores.

- **`solix report`** — a signed, tamper-evident record of every decision, for
  someone other than you to read. `gain` counts what was stopped and `ledger`
  lists what got through; both are plain editable text. This is the same facts
  with a SHA-256 chain over them and an Ed25519 signature on the digest, in
  Markdown, CSV or JSON. `--verify` re-checks a JSON report, `--redact`
  replaces commands with stable fingerprints.

  Scoped honestly: a verified report proves **the file has not been altered
  since the machine produced it**. It does *not* prove the machine reported
  honestly — that machine holds the key. The report says so on its face, and
  so does the CLI, every time.

  This is increment 0 of Solix Teams (`docs/TEAMS-SPEC.md`): the records are
  exactly what a Teams server would aggregate, so the format is exercised by a
  real artifact before anything depends on it over a wire. It needs no server
  and no network.

### Removed

- **The Pro tier, entirely.** Solix is free and MIT, all of it. Gone: the
  three-task cap on free plans, the Pro requirement on full-auto, the
  `solix license` command, `/api/system/entitlement`,
  `/api/license/activate`, the entitlement badge and the paste-a-key box.

  It was unenforceable and aimed at the wrong person. Under MIT the seven
  gate call sites were one edit away from open, and with no telemetry there
  was nothing to meter against — but worse, `FREE_TASK_LIMIT = 3` throttled
  the developer running a twenty-task plan, who is the advocate, not the
  freeloader. See `docs/MONETISATION.md` for where the money goes instead.

### Changed

- **Full-auto now needs only intact worker containment**, which was always a
  safety gate rather than a commercial one. It still skips the *plan*
  approval only: every risky command its workers run is held by the gate,
  which `autoMode` never reaches. The plan panel says so now.

## [1.13.0] — 2026-10-25

**Evidence, and a way to see it without leaving the terminal.**

Solix could govern a fleet but could not show what that was worth, and its
decision surface lived in a browser tab. This release is the other half:
what it prevented, what you allowed, and both of them where you already are.

### Added

- **`solix gain`** — what Solix prevented, read from the audit log: commands
  the denylist refused on its own, decisions you made, plans that paused
  before crossing their cap, and the spend held at those pauses. `--share`
  formats it to paste **by choice**; nothing is collected and nothing is
  sent.
- **The band** (`solix-band` plugin) — pending decisions above the Claude
  Code prompt, with the command in view and Approve / Deny beside it, or a
  quiet line with what the fleet is doing and what it has cost. Draws
  nothing when Solix is not running; `/solix-band status` says why when you
  expected it to. New `GET /api/band`.
- **`solix import`** — backfills the galaxy from Claude Code's own
  transcripts, so a fresh install does not open on nothing. Idempotent,
  sessions keep their real dates, subagent transcripts are skipped so their
  spend is not counted twice.
- **`solix level`** — one governance dial: `observe`, `standard` (default),
  `strict`. Stated on startup and on change, broadcast to every connected
  browser, and a warning rather than a quiet success when lowered. New
  `GET`/`POST /api/system/governance`.
- **`solix ledger`** — what you allowed, and when, with the three patterns
  worth a second look: approvals made late at night, a command waved through
  again and again, something denied and later approved. Exports Markdown and
  CSV.
- **`solix-crew` plugin** — the fifteen advisors as Claude Code subagents,
  plus `/solix-review` on a diff and `/solix-audit` on a repository. No
  server, no account. Both plugins are listed in a marketplace manifest:
  `/plugin marketplace add shmulikdav/Solix`.
- **`docs/E2E-SMOKE-TEST.md`** — 16 suites, ~70 cases, for the parts only a
  human at a real terminal can check.

### Changed

- **Containment refusals have their own audit kind.** They were filed as
  `permission_denied`, the same kind a human denial uses; conflated like that
  it was impossible to say how much the denylist caught on its own. Mission
  Control counts the new kind explicitly rather than shedding them, and
  `budget_paused` is recorded where nothing was before.
- The README scopes the approval gate to the tasks Solix launches.
  `SOLIX_GATE_ENABLED=1` is injected by the launcher and by nothing else — a
  `claude` session you start yourself is observed and costed, and keeps
  Claude Code's own permission prompt.

### Fixed

- **`solix demo` seeded no cost at all**, so Mission Control opened on
  $0.00 spend and $0.00 per mission — a cost-governance product showing
  every figure as zero, to the first-time user the README sends there.
  Dollars now derive from token counts through the same `costForUsage` the
  transcript watcher uses.
- Two tests that failed on macOS under load, both defects in the tests: a
  path compared before resolving `/var` → `/private/var`, and three
  assertions that waited for an element rather than its content — one of
  which made a leak check pass against a string containing no diagnostics at
  all.

### Verification

The gate's happy path is now covered end to end: `gate.live.test.ts` runs the
real `pre-tool-bash.sh` against a listening server, a human answers through
the same API the browser uses, and the decision comes back. 487 tests, 12
plugin tests, 21 browser smoke steps, and a clean-machine rehearsal.

What no test here covers is whether Claude Code honours the decision it is
handed. That needs a real agent — Suite E of the smoke test.

## [1.12.1] — 2026-10-19

### Fixed

- `solix demo` showed no spend (see 1.13.0, where the full fix landed).
- Two macOS-only test failures.
- The tagline across the CLI banner, `--help`, both package descriptions and
  the READMEs: "the control layer for your coding agents".

## [1.12.0] — 2026-10-16

**Maestro: describe a goal, watch your agent fleet build it — 100% local.**

Solix goes from *observing* agents to *orchestrating* them. Everything here is
additive and backward-compatible; the paid tier ships dormant (free public beta
— everything unlocked).

### Added

**Orchestration**
- **Maestro orchestrator.** Give a goal → a planner decomposes it into a task
  plan you approve → Solix dispatches one agent session per task (each its own
  planet), verifies each result against acceptance criteria, retries with
  feedback, and drives the build to done. New Plan panel (press `P` / ✷ Maestro)
  and dispatch beams in the galaxy.
- **Build studio.** Create a project in-app (scaffold + `git init`), let Maestro
  build into it, review the real diff of what changed, preview the result, and
  iterate with a follow-up goal.
- **Rich task threads.** Every task keeps a chronological thread — dispatched →
  worker result → verified / retry / escalated / aborted — interleaved with your
  own comments. Expand a task to read its full run history and leave a note.
- **Comment-on-passage → follow-up tasks.** Comment on a changed file in the
  review diff and "Fix it" turns the note into a worker task on the same plan,
  which re-runs to address exactly that feedback.
- **Agent delegation.** A worker that genuinely needs to may *propose* subtasks;
  the orchestrator validates them against a depth cap, a count cap and the same
  entitlement gate before dispatching. The worker never dispatches directly, so
  the loop stays deterministic and contained.

**Governance & cost**
- **Governed autonomy.** A kill-switch, per-plan budget cap, and a
  safe-by-default command denylist (blocks `rm -rf /`, out-of-cwd writes, etc.)
  govern every worker with no setup; a per-run full-auto toggle for trusted flows.
- **Budget threshold alerts.** A one-time heads-up at ~80% of a plan's cap before
  the hard pause at 100%, so the ceiling never arrives as a surprise.
- **Scoped connections & secrets.** Store API keys once and grant them per
  advisor / per plan; a worker only ever sees what it was granted, injected at
  dispatch. Values are write-only and encrypted at rest.

**Automation & teams**
- **Richer routine triggers.** Routines gain a trigger kind — **webhook** (fire
  via an inbound POST to a per-routine capability URL) and **manual** (on
  demand) alongside interval — plus an owner and recorded run history.
  `solix schedules fire` / `solix schedules runs`.
- **Ready-made team templates.** One-click advisor + skill + routine bundles
  (ship-fast build team, quality & security gate, launch & devrel, architecture
  & data), from the Galaxy panel's Teams tab or `solix teams install <id>`.
- **Skill authoring.** Create, edit, version, restore and dry-run your own
  skills, stored under `~/.solix/skills` and discovered like the bundled ones.
  Bundled skills stay read-only.
- **Chat connectors.** Post fleet events (plan done/failed, task escalated,
  budget alert) to Slack or Telegram; credentials are encrypted at rest and
  never returned. With webhook routines, you can drive *and* monitor from a phone.
- **Multi-org tenancy.** Orgs isolate your plans and goals; switch the active org
  from the top bar or `solix orgs`.

**Platform**
- **Multi-runtime (experimental).** Groundwork for running Codex alongside Claude
  Code — see `docs/multi-runtime.md` for exactly how far this is verified.
- **Pro licensing (dormant).** Offline, signature-verified license support +
  `solix license activate` — off by default (free beta); nothing to buy yet.
- `SOLIX_CLAUDE_BIN` / `SOLIX_CODEX_BIN` override the agent executable, for
  non-standard installs (nvm shims, custom prefixes, wrapper scripts).
- **Tests + CI.** A suite of 318 tests and PR-gating CI, from zero — including
  an end-to-end launcher test against a real subprocess, a populated-legacy-
  database migration test, a launcher↔hook contract test, and a headless
  browser smoke check (`pnpm smoke:browser`).

### Fixed

These affect anyone upgrading from 1.11.8:

- **Native Windows is now declined, loudly, instead of failing silently.**
  The hooks are POSIX shell scripts using `$PPID`, `date +%s`, `pwd` and
  `curl`; Windows `cmd` cannot execute them. Solix wrote and registered them
  anyway, so a Windows user got a running UI, an empty galaxy, and nothing
  explaining why. `solix start` now says so up front and points at WSL — where
  Solix already works today, because WSL reports as linux — and `solix install`
  refuses rather than reporting a success that isn't one. `solix demo` and the
  UI are unaffected and run anywhere Node does.

  Rewriting the hooks in Node would be portable but was measured and rejected:
  `sh` starts in ~2ms against node's ~37ms, and PreToolUse/PostToolUse fire on
  every tool call in the agent's blocking path. Paying ~70ms per tool call on
  every platform to serve one is the wrong trade. Real Windows support means
  native `.cmd` hooks, verified on Windows.
- **`solix doctor` now reports what a bug report needs** — platform, Solix and
  Node versions, and whether the installed hooks match the running build.
- **Uninstalling could silently revert your Claude Code settings.**
  `solix uninstall` restored the backup wholesale whenever one existed — and
  that backup is taken *once*, at first install. Anything you added to
  `~/.claude/settings.json` afterwards (your own hooks, MCP servers,
  permissions, env) was quietly rolled back to the install-time snapshot.
  Removing a tool is not consent to roll back a file the tool is a guest in.
  It now always removes only its own hook entries, leaving everything else —
  including other tools' hooks on the same events — untouched. The backup is
  kept for the one case surgery cannot handle, a `settings.json` that no
  longer parses, and that path says what it did.
- **Upgrades left you on the previous release's hook scripts.** The first-run
  check only asked whether the hook files existed, not which version wrote
  them, so every release after the first would start up, see "installed", and
  skip — running new server code against old hooks indefinitely. The install
  is version-stamped now; a mismatch re-wires and says which version it is
  coming from.
- **Installing is one command now.** `solix start` never checked whether its
  Claude Code hooks were wired — it booted the server, opened the browser and
  printed "start any `claude` session to see your first planet appear", which
  simply never happened if you had skipped `solix install`. An empty galaxy,
  forever, with no error explaining it. First run now wires the hooks itself
  and says exactly what it changed, where the backup went, and that
  `solix uninstall` reverses it. On a machine with no Claude Code it wires
  nothing and points at `solix demo` instead of creating a config directory
  for software that isn't there.

  `npm i -g @shmulikdav/solix` then `solix` is the whole install.
  `solix install` remains for scripted setups and `--force` re-wiring.
- **`pnpm rehearse` installs the tarball on a throwaway machine.** The test
  suite exercises the repo; this exercises what a beta tester actually
  receives. It packs the CLI, installs it globally into a temporary prefix
  against a temporary HOME, starts it, fires a real hook script, checks the
  session arrives, and uninstalls — covering the failures only packaging can
  produce, like a file that builds locally but never reaches `dist`.
- **"Report a problem" in the rail.** There was no way to report anything
  from inside Solix — you had to find the repo yourself, run `solix doctor`
  in a terminal and work out which parts mattered. It now collects the same
  information and opens a prefilled GitHub issue, so a problem you hit
  actually reaches someone. New `GET /api/diagnostics` carries version, Node,
  platform, hook state (including whether the installed hooks match the
  running build) and session counts; the CLI supplies the hook half, since
  it owns the install.

  It shows you the payload first. Solix's claim is that nothing leaves your
  machine, so the one control that offers to send something outward owes you
  a look at it — and what it sends is versions, counts and hook state, never
  a path, a project name or a prompt. That is enforced by a test, and by a
  browser step that fails if a filesystem path appears in the payload while
  thirty-odd demo sessions are running.
- **⌘K opens a command palette.** Eleven rail destinations plus six Fleet
  sections is a reasonable amount of navigation to see and a poor amount to
  traverse when you know where you are going — and none of it reached your
  agents, which were otherwise findable only by picking the right dot out of
  a 3D scene. The palette indexes every surface, every Fleet section, and
  every agent by name. It deliberately cannot approve a decision or start a
  routine: acting on a tool call you cannot see is the thing the Y/N gate
  exists to prevent, so it takes you to Decisions instead.
- **The connection indicator says `Live` again.** Reducing it to a bare dot
  was an over-correction from "this pill looks like a button" — the result
  was unreadable, which was the complaint. A dot plus one word is legible and
  still not button-shaped; the tooltip keeps the retry-and-staleness detail.
- **Fleet's tab strip is gone and its sections are grids.** The strip listed
  the same six sections the rail already lists, so it was the navigation
  twice — and it was the copy that truncated "Connections" at 480px. The
  header now says which section you are in and what it is for, which the
  strip never did. Crew, Teams, Routines, Connections and Skills lay out as
  responsive grids instead of one card per row: Crew shows twelve advisors at
  once where the dock showed about two.
- **Surfaces cap their content width.** Full width is room to work, not
  licence to run a sentence to 1400px — the column centres at a readable
  width so the header and the body share a left edge, while card grids still
  get two or three columns.
- **Mission Control, Maestro, Share and Fleet now use the whole window.**
  They were 480px right-hand docks, which was the wrong container for all
  four: Fleet's six sections truncated in a tab strip, Crew showed one card
  per row forever, and Maestro's diffs had nowhere to go. They are workspace
  surfaces now and replace the canvas rather than covering it.
- **A panel about an agent no longer closes when you open Fleet.** One
  mutually-exclusive field held both "which surface am I working in" and
  "which thing did I click in the scene", so the two fought: opening Fleet
  shut the transcript you were reading. They are separate now — a contextual
  dock floats over whichever surface is up — and Escape closes the nearest
  one first rather than throwing away both.
- **Pending decisions moved into the rail.** The queue used to float over the
  galaxy permanently, taking a 320px column whether or not anything was
  waiting, and twice it was found underneath something because the arithmetic
  keeping it clear had to be re-derived every time the layout moved. It is a
  rail destination now — "Decisions" under Watch, with the pending count beside
  it — and the panel opens when you click it. The count is the signal, and it
  cannot be covered, because the rail is always there.
- **`Y` and `N` now refuse to act unless the card is on screen.** They resolved
  the top pending request from a global key handler with no visibility check.
  That was survivable while the queue was always visible; with it behind a
  click it would mean approving a command you never read. The shortcuts are
  gated on the Decisions panel being open.
- **Navigation moved out of the top bar into a left rail.** One 44px strip was
  carrying four unrelated jobs — identity, live status, the view switch, and
  seven destinations, two with their own sub-tabs — so it wrapped onto a second
  row at every window width, and no amount of shaving pixels fixed that.
  Destinations are now a left rail grouped by what they are for: watch the
  fleet, build with it, govern it. Fleet shows its six sections as rows instead
  of a tab strip where "Connections" truncated. The strip that remains says
  where you are and whether anything needs you, and is a single row at 1280px —
  which it had never been.
- **The connection indicator looked like a button and wasn't one.** `CONNECTED`
  / `OFFLINE` was a bordered pill styled exactly like the controls beside it,
  and clicking it did nothing — which teaches people to distrust the styling
  everywhere else. It is a dot now: solid when connected, hollow and pulsing
  when not, so the state does not depend on telling green from red. Hovering
  or focusing it says what the chip had no room for — that the socket retries
  every 1.5s on its own, and that the galaxy on screen is stale until it
  succeeds.
- **A first-run hint that the sun is clickable.** `EmptyHint` explains the
  metaphor while the system is empty and then vanishes at exactly the moment
  you first have something to click. A one-time hint fills that gap, and
  stands down while a permission is pending.
- **Three buttons said less than they did.** "Plan", next to a field reading
  "Refine or add a follow-up goal", created a brand new plan rather than
  refining the existing one — it is "New plan" now, and the field says what it
  does. "Add" meant add-a-connection in one panel and add-a-goal in another;
  "Apply" meant import-a-galaxy.
- **One project picker instead of three.** The plan panel, the team installer
  and the routine form each had their own project `<select>` and working-
  directory input, with near-identical styling and three different wordings
  for the same field. They share one component, and a test keeps a fourth from
  appearing.
- **"Approve & run" was green.** It dispatches one agent per task and is the
  largest single spend in the product, wearing the same colour as "enabling an
  advisor is free". Colour now means something: amber is "this spends money",
  red is "this stops or destroys something", green is "free or succeeded",
  purple is the one primary action on a surface, and navigation is neutral —
  opening a panel never costs anything. Approve & run also states how many
  agents it will start and whether the plan has a budget cap.
- **Two spend controls were disguised and three free ones were not.** Pin,
  Invoke, Launch, Send, Plan, Fix it, Post and Install team are all amber now;
  creating a project, saving a skill and activating a license are not, because
  they cost nothing. A test enforces this on every button so the palette cannot
  drift back.
- **"Raise cap" was a browser prompt feeding parseFloat.** Typing "20 dollars"
  silently set the cap to 20 and typing "twenty" silently did nothing. It is a
  number input that shows the new cap before you commit, and it is amber rather
  than green, because raising a cap lets an agent spend more.
- **The timeline drawer covered the plan panel's Approve and Abort buttons.**
  Both are z-30 and the drawer renders later, so it won on the tie. It now
  stops at the dock's edge.
- **The first command the README suggests destroyed onboarding.** The welcome
  modal only rendered when there were zero sessions, and `solix demo` — the
  quick start's first step — seeds about thirty. Anyone who followed the
  instructions never saw onboarding, and nothing brought it back. It now shows
  until you dismiss it, whatever is on screen.
- **Opening help silently consumed a new user's onboarding.** Help and the
  welcome modal were one component, and help's "Got it" wrote the first-run
  dismissed flag. They are separate now; closing help writes nothing.
- **The welcome modal could not be dismissed.** No ✕, no backdrop handler, and
  its Escape path only cleared a flag that is already false on a genuine first
  run. All three work now.
- **Returning users saw a frame of the welcome modal on every load**, because
  the dismissed flag hydrated from localStorage in an effect, after first
  render. It is read synchronously.
- **Recurring spend could be started from the app but only stopped from a
  terminal.** Installing a team creates interval routines, and each run launches
  a real agent session that costs money. The web app had one read-only selector
  for routines and no way to list, pause, fire or delete one — to stop a routine
  you had to leave the app and run `solix schedules`. Fleet › Routines now shows
  every routine (including disabled ones), says plainly how many are running on
  a schedule and spending money, and can disable, run and delete them. Creating
  one states the recurring cost before the button, and "Run now" takes a
  confirm, since it starts an unsupervised session with one click.
- **Mission Control had no button.** The whole-workspace overview opened only by
  clicking the 3D sun or pressing `W` — and the sun does not exist in List or
  Missions view, so there the panel was keyboard-only and effectively
  undiscoverable. It now has a top-bar button; the sun and `W` keep working.
- **A pending permission prompt could be hidden behind a panel.** Two groups of
  side panels tracked their open state separately — one in component state, one
  in the store — and never coordinated, so two panels could be open at once.
  The one on top won visually, but the Decision Queue positioned itself from the
  other one's width and slid partly underneath. Approving or denying an agent's
  action is how you unblock a stuck agent, so the prompt going missing was a
  safety problem, not a cosmetic one. There is now exactly one open panel at a
  time, and the queue's offset is derived from that single source.
- **A missing texture could blank the entire UI.** The 3D scene wrapped its
  textured planets in `<Suspense>` with a procedural fallback — but Suspense
  covers the *pending* state, not failures. A failed texture load threw past it
  and, with no error boundary in the app, unmounted the whole tree: black page,
  no HUD, no panels. Textured bodies now sit behind a real error boundary and
  degrade to the procedural look as always intended, and the scene as a whole is
  boundaried so it can never take the HUD down with it.
- **Missing static assets returned `index.html` with HTTP 200.** The SPA
  catch-all answered any unmatched path with the app shell, so a missing asset
  came back as HTML the browser then tried to decode as an image. File-shaped
  paths now 404 properly; client-side routes still fall through.
- **Upgrading a long-dormant database could fail.** An index was created from the
  base schema against a column that a later migration adds, so opening a
  database predating that column threw on boot. The same ordering issue also
  made the `sessions.origin` CHECK relaxation silently roll back.

### Changed

- **Onboarding is three choices instead of six cards.** The old modal
  explained the whole product before letting you do anything and ended on a
  feature marked "(preview)", while omitting five shipped surfaces. It now
  offers one action to take — each says whether it costs money — and the
  reference material moved to `?`, which gained the complete shortcut legend
  (the old one listed 11 keys and omitted 8 that were bound), a plain-language
  key to the sun / planet / moon / belt vocabulary that previously existed only
  in hover tooltips, and a getting-started checklist that ticks itself off from
  real state.
- **Crew, Connections, Skills, Teams, Orgs and Routines are now one Fleet
  panel.** Four of these each had their own top-bar button, so configuration
  competed for attention with the things you actually do, and the bar grew by
  one control per feature. They are tabs now, behind `⚙ Fleet`. The `C`
  shortcut still goes straight to Crew. Crew's cards were restructured for the
  narrower column rather than just moved, and the org switcher's `window.prompt`
  is gone — new orgs use an inline form, and the active org stays visible in the
  bar as a label since it changes which plans Maestro lists.
- **The Galaxy panel is now the Share panel.** "Galaxy" named two unrelated
  things five controls apart in the same bar: the 3D view (`V`) and the
  export/import panel (`G`). The panel is renamed to Share, which is what its
  tabs actually do — export, import, versions and audit. `G` is unchanged.
- **Installing a team now states what it will actually do.** Two of the three
  things a team install performs are bookkeeping — enabling advisors is a flag,
  and "installing" a skill only records an association. The routines are the
  only part with an ongoing effect: an interval routine launches a real agent
  session on a cadence and spends money on every run. The install card now says
  so in plain language per template ("runs automatically every 1d — each run
  starts a real agent session and costs money" vs "fires only when its webhook
  URL is called"), and the routines are a declinable checkbox. The default is
  unchanged, so a team is still complete out of the box — what's removed is the
  surprise, not the feature.
- **A fired routine is now governed by containment.** Routines launched
  unattended previously ran with no gate: their tool calls were observed but
  never blocked, unlike Maestro workers. A routine is now its own session role,
  correlated via `--session-id` so the gate can identify it, and governed by the
  denylist — destructive commands and out-of-project writes are hard-denied,
  ordinary work auto-allows. It deliberately does *not* queue a permission
  prompt: a routine often fires overnight, and a prompt nobody answers would
  time out and fail the run. Sessions you start yourself are unaffected.
  Note that containment implies the environment allowlist, so a routine relying
  on ambient environment variables now needs `SOLIX_ENV_PASSTHROUGH`.
- **Releases ship textured.** `prepare-assets` now runs on the publish path, so a
  published build contains the planet and sky textures rather than silently
  shipping the procedural look. It is deliberately not part of `pnpm build` —
  that would put a network fetch in every compile and break offline/CI builds.

### Notes
- The Pro gate is inert until enforcement is turned on — this release changes
  nothing about what existing users can do.
- **Codex support is experimental and unverified against the real CLI**, and
  `solix install --codex` is not implemented. See `docs/multi-runtime.md`.
- Multi-org is a logical model over the existing local SQLite store. A
  Team-edition Postgres/S3 backend is a documented configuration seam
  (`/api/system/storage`), not an implemented driver.
- Several defects in this release's own pre-release code were caught and fixed
  before shipping — most notably a worker-gate policy mismatch that would have
  failed open. None of them ever reached a published version; they are recorded
  in the git history rather than here, since no user was affected.


## [1.11.8] — 2026-09-04

**Cost at a glance, and honest advisor economics.**

### Added
- **Cost column + per-row Terminate in the List view.** The dense table now shows each
  agent's estimated spend ($) as a sortable column, and a hover **Terminate** button per
  row — so the compact "matrix" board surfaces cost alongside status/context/health and
  gives an inline action. (Approvals stay in the Decision Queue, which already shows the
  exact command/diff.)
- **Advisor cost transparency in the Crew panel.** Made the economics explicit: enabling
  an advisor is free (no API calls); a `free` chip marks enabled advisors, and pinned
  advisors show their live spend (`pinned · $X.XX`). Clarifies that advisors only cost
  tokens when you pin or invoke one.

## [1.11.7] — 2026-09-04

**Launch hardening: `solix demo` can't get stuck, and the UI tells you when it's stale.**

### Fixed
- **`solix demo` no longer gets permanently stuck after a failed run.** A demo that
  failed to start used to leave its sandbox server orphaned (a `SIGTERM` that a
  mid-boot process could ignore), and only the most recent PID was ever cleaned up — so
  orphans piled up, held the port and the sandbox DB, and made every later run fail. Now
  the demo reaps **all** stale sandbox servers on startup and kills its own child
  reliably (SIGTERM → SIGKILL) on both failure and Ctrl+C, so a bad run can never
  poison the next one.
- **Clearer demo startup error.** Instead of a generic "failed to start", the demo now
  says whether the server *crashed* (pointing you at the error above) or *started but
  isn't reachable* (pointing at a firewall / security tool blocking localhost, or a
  stuck server) — with a suggestion to try a fresh `--port`.

### Added
- **"New version — Reload" banner.** When the running Solix server is newer than the UI
  bundle your browser is showing (a stale service worker / cached shell after an
  upgrade), a banner now offers a one-click hard refresh (unregister service workers +
  clear caches + reload) — no more hunting through DevTools to see a shipped fix.

## [1.11.6] — 2026-09-04

### Fixed
- **The New Task modal no longer runs off the top/bottom of the screen.** On shorter
  windows the form grew to its full content height and overflowed the viewport (the
  title and footer were clipped). It now uses the same centered, height-capped layout
  as the Crew roster — pinned header and footer with the form scrolling in between —
  so it always fits on screen with the Launch button reachable.

## [1.11.5] — 2026-09-04

**The demo starts reliably even with a large Agent View history.**

### Fixed
- **`solix demo` no longer stalls when `~/.claude/jobs` is large.** 1.11.4 fixed the
  `CHECK` error that had been silently *aborting* Agent View sync — which, as a side
  effect, meant sync then did real work: on boot it scanned the entire `~/.claude/jobs`
  and inserted every session in one synchronous burst, freezing the server long enough
  that the demo's health check timed out (now even at 30s). Two fixes:
  - The demo sandbox now runs fully isolated from your real Agent View state
    (`SOLIX_DISABLE_AGENTVIEW`) — it has its own seeded database and shouldn't mirror
    external sessions into it, nor scan a heavy jobs directory in a throwaway sandbox.
  - For real `solix start`, the initial Agent View scan now yields to the event loop as
    it goes, so a large jobs directory never blocks the server from responding —
    sessions stream in as they're found instead of arriving in one freeze.

## [1.11.4] — 2026-09-03

**`solix demo` starts reliably, and Agent View sessions finally sync.**

### Fixed
- **`solix demo` no longer fails with "sandbox server failed to start within 8s."** On a
  cold first run (right after `npm i -g`), the server does all of its boot work
  synchronously before binding the port — loading the native SQLite addon, seeding
  advisors, scanning skills, and scanning `~/.claude/jobs` for Agent View. On a busy
  machine that could exceed the 8s the demo waited, so it killed a server that was about
  to be ready. The demo now waits up to 30s, and the initial Agent View scan is deferred
  off the boot path so the port answers immediately.
- **Agent View background sessions now appear as planets.** The `sessions.origin` column
  had a leftover `CHECK (origin IN ('external','internal'))` that rejected Agent View's
  `'agentview'` origin — so every sync threw `CHECK constraint failed` and no background
  session ever showed up. The constraint is removed for new databases and relaxed
  in-place (data-preserving) on existing ones, so upgrading installs pick up their Agent
  View sessions on the next start. This also unblocks future multi-tool origins.

## [1.11.3] — 2026-09-02

### Changed
- **Soft galaxy behind the modals.** With the label z-index fixed in 1.11.2, the New
  Task / Crew modal backdrop no longer needs to be opaque to stay clean — restored a
  dimmed, blurred galaxy behind them for the "floating in space" look, with the form
  still fully readable.

## [1.11.2] — 2026-09-02

### Fixed
- **Galaxy labels no longer float over the modals — the *actual* fix for "the galaxy
  shows through the New Task / Crew forms."** The planet and project name labels are
  drei `<Html>` overlays, which default to a z-index in the millions, so they rendered
  *on top of* the centered modals — it was never the panel background (which is opaque).
  The labels are now pinned to a low z-index (`zIndexRange`), keeping them in the galaxy
  layer beneath the HUD and all panels.

## [1.11.1] — 2026-09-02

### Fixed
- **Modal backdrop is now fully solid.** 1.11.0 dimmed the New Task / Crew modal
  backdrop to 90%, but on some setups a faint galaxy still showed through the panel. The
  backdrop is now the solid app background, so the scene is completely hidden behind the
  modal and the form is always fully readable.

## [1.11.0] — 2026-09-02

**More models to pick from, and the modals stop showing the galaxy through them.**

### Added
- **Claude 5 model options in the New Task picker.** Alongside the auto-updating tier
  aliases (default / opus / sonnet / haiku), you can now pin **Opus 5, Sonnet 5, Haiku 4.5,
  and Fable 5.1** explicitly. Planets stay color-coded by tier (Fable gets its own pink).
  Pinned model ids only launch if your Claude Code + plan can access them.

### Fixed
- **Galaxy no longer bleeds through the New Task / Crew modals.** The opaque panel was
  nested inside a `backdrop-blur` element, which some browsers composite translucently, so
  the busy scene showed through the form (worst in the dense center). The blurred backdrop is
  now a sibling layer behind the panel (matching the docked panels that never bled), and it's
  darkened so the panel reads solid.

## [1.10.0] — 2026-09-02

**The sun comes alive — click it for Mission Control.**

### Added
- **Clickable sun → "Mission Control."** The central sun was decorative; now
  clicking it (or pressing `w`) opens a right-docked overview of the whole
  workspace: total spend, cost per completed mission, interventions (from the
  audit log), active / needs-you / idle counts, mission tallies, context
  pressure, and a clickable "needs-you" list that jumps you to whichever agent
  is waiting. All figures are real — no new tracking.
- **A living star.** The sun's light brightens and it grows slightly as more
  agents work, and its solar flares flick faster and redder whenever a session
  needs a human — so the center of the screen signals status before you click.

## [1.9.3] — 2026-09-02

**Decision-card polish and a crew self-heal salvaged from earlier PRs.**

### Fixed
- **Decision-Queue cards are fully opaque** ([#7](https://github.com/shmulikdav/Solix/pull/7)). The permission and budget cards used a translucent `bg-solix-danger/10`, so the galaxy bled through them; they're now solid, keeping the red border and header as the danger signal.
- **Crew roster self-heals, plus a boot diagnostic** ([#5](https://github.com/shmulikdav/Solix/pull/5)). The Crew panel re-reads `/api/advisors` on open, so it populates even when the initial WebSocket snapshot arrives empty; and the server logs its resolved DB path with advisor/session counts at startup, making "empty UI" reports diagnosable in one line.

## [1.9.2] — 2026-09-02

**macOS observability fix — hooks work on BSD `date`, and status pings stop opening "unknown" permission cards.**

### Fixed
- **macOS: session and tool observability were silently broken** ([#2](https://github.com/shmulikdav/Solix/issues/2)). On macOS a fresh `solix install` left the dashboard stuck on "EMPTY SYSTEM" — no planets, no comets — with no error anywhere. Three combined causes, all fixed:
  - 6 of the 9 hook scripts POSTed to the token-guarded `/events` endpoint **without** the `X-Solix-Token` header, so every event got a 401 and was silently swallowed. All 9 hooks now send the token.
  - Every hook built its timestamp with `date +%s%3N`; `%N` is a GNU extension, so BSD `date` on macOS emitted a literal `N` and produced invalid JSON the server dropped. Hooks now use POSIX arithmetic (`$(($(date +%s) * 1000))`), which yields millisecond timestamps on both BSD and GNU.
  - `Notification` events were all treated as permission requests, so Claude Code's benign "waiting for your input" pings rendered as **"unknown"** Approve/Deny modals and flipped the planet red. The server now promotes a notification to a permission decision only when it carries a `tool_name`; otherwise it just surfaces a toast.
- **Panels and modals are fully opaque.** The `solix.panel` color had baked-in alpha, capping every `bg-solix-panel/NN` at 0.8 so scene labels bled through the modals; it's now a solid color, with darker modal backdrops ([#3](https://github.com/shmulikdav/Solix/pull/3)).

Thanks to the detailed macOS onboarding report in [#2](https://github.com/shmulikdav/Solix/issues/2).

## [1.9.1] — 2026-09-01

**Getting-started docs go npm-first, and the stale-UI service-worker trap is fixed.**

### Fixed
- **PWA service worker no longer precaches the app shell.** After a `solix`
  upgrade (or a rebuild) the service worker used to keep serving the old
  JS/CSS/HTML bundle until it eventually revalidated, making shipped fixes look
  like they hadn't landed. The shell now always comes fresh from the local
  server — which is always up whenever the UI is — and only the icons/manifest
  are precached, for installability (`navigateFallback: null`). Precache dropped
  from 13 entries (~1.3 MiB) to 6 (~96 KiB).

### Changed
- **Getting-started guides are npm-first.** `DEMO.md` and `DEMO_PM.md` now start
  from `npm i -g @shmulikdav/solix` instead of cloning the repo, and drop the
  from-source `pnpm install` / build steps and the `cd ~/Solix` references.
  `DEMO_DEV.md` remains the from-source developer guide.

### Added
- **Launch banner** (`docs/galaxy.png`) for the README hero and launch listings,
  re-rendered lighter (1.26 MB → 788 KB).

## [1.9.0] — 2026-08-31

**Live showcase demo, cross-origin hardening, and launch-readiness fixes.**

### Added
- **Live showcase demo.** `solix demo` now boots its own sandboxed server
  (isolated `~/.solix/demo.db`), seeds a saturated galaxy (~30 sessions across
  8 projects, all 14 advisors, missions, comets, moons, permission flares),
  and runs a continuous ticker until Ctrl+C — a fully synthetic showcase that
  needs no real Claude Code. `--no-ticker` seeds a static snapshot; `--keep`
  preserves the sandbox DB; `--no-server` seeds against a server you already
  have running.

### Security
- **Closed the cross-origin control-plane hole.** The install token guarded
  only `/events`, while `/ws` and every `/api/*` route were open — and because
  browsers don't CORS-check WebSocket handshakes (and can send "simple"
  cross-origin POSTs), any page a user merely visited could open
  `ws://127.0.0.1:4242/ws` or POST to process-spawning routes and drive their
  agents. A loopback **Origin allowlist** now gates the WS upgrade and all
  state-changing HTTP requests (non-browser callers with no Origin — hooks,
  `curl`, `solix demo` — are unaffected), plus an **SSRF guard** on
  `POST /api/galaxy/import`.

### Fixed
- **Skill pack ships in the npm tarball.** `copy-static.mjs` now bundles
  `packages/skills` into `dist/skills`, and `packagedSkillsDir()` resolves it —
  global installs previously got an empty asteroid belt despite the docs.
- **`/api/health` reports the real version** (was a hardcoded `1.0.0`).
- **`schedules` / `goals` command wiring** matched their handler signatures,
  restoring a clean `tsc` (the publish workflow's typecheck gate).
- **`solix demo` no longer crashes on headless machines** — a missing browser
  opener emitted an unhandled async `spawn` error after seeding.
- **Right-side panels clear the TopBar** and the **Decision Queue sits beside
  an open panel** instead of overlapping it.

## [1.8.0] — 2026-05-24

**Security hardening — enforcing approvals, opt-in sandbox, and local-API auth.**

Until now Solix was an *observational* oversight layer: hooks were
fire-and-forget, so clicking **Deny** updated the UI but never actually stopped
the tool. This release makes approvals able to truly block — opt-in, and
fail-open by default so a Solix outage never wedges an agent. All three features
below are additive and off (or transparent) unless you turn them on.

### Added
- **Enforcing approval gate** (opt-in via `SOLIX_GATE_ENABLED=1`). The sensitive
  PreToolUse hooks (Bash, file writes, Task) become a **synchronous gate**: they
  POST to the new blocking `/events/permission` endpoint and wait until you
  Approve/Deny in the browser, then return Claude Code a real
  `permissionDecision`. **Deny** now blocks the tool; **Approve** releases it.
  Configurable fail policy via `SOLIX_GATE_POLICY` (`fail-open` default /
  `fail-closed`), `SOLIX_GATE_TIMEOUT` (hook, default 305s), and
  `SOLIX_GATE_TIMEOUT_MS` (server, default 300000).
- **Opt-in sandbox for Solix-launched agents.** `SOLIX_ENV_SCRUB=1` passes only
  an allowlisted environment (plus `ANTHROPIC_*` / `CLAUDE_*` and an opt-in
  `SOLIX_ENV_PASSTHROUGH`) so unrelated host secrets don't leak into agent
  subprocesses; `SOLIX_SANDBOX_CMD` wraps the spawned `claude` with a
  user-supplied jail (e.g. `bwrap …`, `sandbox-exec …`). Unset → no change.
- **Local-API authentication.** `solix install` writes a per-machine secret to
  `~/.solix/token` (mode 0600); hooks send it as `X-Solix-Token` and the server
  requires it on the spoofable `/events` ingestion surface. CORS is now
  restricted to known localhost origins (was wide open).
- **`SECURITY.md`** documenting the trust model and every env var, and a
  runnable **zero-to-one demo** (`scripts/demo-zero-to-one.sh`,
  `pnpm demo:zero-to-one`) with the `ZERO-TO-ONE.md` checklist.

### Changed
- `router` gains `requestPermission()` (the blocking gate path) while
  `resolvePermission()` now releases held gate requests; the observational
  `Notification` path is unchanged, so both coexist.
- Installs that predate the token simply run without enforcement until you
  re-run `solix install`.

## [1.7.0] — 2026-05-21

**Sprint N — Crew roster: discover & enable opt-in advisors, plus four new advisor types.**

The five opt-in advisors that shipped disabled were invisible and unreachable
from the UI — the only way to turn one on was the CLI. This release surfaces
them and grows the lineup to **14**.

### Added
- **Ghost planets** — opt-in (disabled) advisors now render as dim, pulsing
  planets on a faint outer ring. Click one to open its panel and press
  **＋ Add to crew** to enable it; it moves into the live inner ring (and the
  `+ Task` picker) without a reload.
- **Crew roster panel** — a new panel (TopBar **✦ Crew** button or press **C**)
  listing every advisor grouped **Active crew** vs **Available (opt-in)**, each
  with one-click Enable / Disable / Pin / Details. Header shows
  `N active · M available`.
- **Four new advisor types** (all opt-in, auto-seeded on next `solix start`):
  - **Cinder** ⚑ — Debugger / Incident (sonnet): triages failures from stack
    traces, logs, and failing tests.
  - **Delta** ⛁ — Data / DB Engineer (sonnet): schema, migrations, queries,
    data integrity.
  - **Spire** △ — Architect (opus): system design and trade-offs, distinct
    from Forge who builds.
  - **Ledger** ₵ — FinOps / Cost (haiku): watches spend against per-session
    budgets and suggests cheaper models.

### Changed
- New `set_advisor_enabled` WebSocket message routes through the server router,
  which broadcasts `advisor_upsert` live. Enabling/disabling from the UI updates
  instantly, and `solix advisors enable <id>` now also pushes the change to open
  browsers.
- README advisor table expanded to 14 rows; `CLI.md` and `OPERATING.md` document
  UI-based discovery of opt-in advisors.

### Fixed
- Restored the correct Compass glyph (`⌖` U+2316) in the advisor manifest.

## [1.6.0] — 2026-05-21

**Sprint M — Cost rings, Heartbeats, and Goal constellations.**

Three additive systems for running agents at scale: spend visibility, scheduled
tasks, and goal grouping.

### Added
- **Cost rings & budgets** — per-session spend is estimated live from the token
  usage Claude reports (model pricing × tokens) and drawn as a budget ring that
  fills sky → amber → red as it approaches the cap. Set a per-task **Budget
  (USD)** in the `+ Task` modal; a breach raises a card in the Decision Queue
  (**Raise cap** / **Dismiss**) and soft-pauses Solix-launched sessions. Costs
  are estimates, not billing figures.
- **Heartbeats** — recurring scheduled tasks via `solix schedule`
  (`add` / `list` / `enable` / `disable` / `remove`) on a `30m` / `2h` / `1d`
  cadence. Each enabled schedule renders as a pulsing node and launches a normal
  session when due (server checks every ~30s).
- **Goal constellations** — named objectives via `solix goal`
  (`add` / `list` / `remove`). Pick a goal in the `+ Task` modal (or create one
  inline); planets working toward the same goal are linked by constellation
  lines in the goal's color, and the SidePanel shows a goal chip.

### Changed
- New `@solix/shared` pricing module (`MODEL_PRICING`, `costForUsage`,
  `totalTokens`).
- New WebSocket messages (`cost_update`, `budget_alert`, `schedule_*`,
  `goal_*`), client messages (`raise_budget`, `dismiss_budget_alert`), and
  `launch_session` fields (`budgetUsd`, `goalId`).
- New SQLite columns (`cost_usd`, `budget_usd`, `current_goal_id`,
  `missions.goal_id`, `scheduled_tasks.cwd/name`) and a `goals` table, all via
  idempotent migrations.

## [1.5.0] and earlier

- **1.5.0** — Agent View bridge: auto-syncs with Claude Code 2.1.139+ background
  sessions; tasks launched from Solix round-trip into `claude agents`.

For releases before this changelog was introduced, see the
[Git history](https://github.com/shmulikdav/Solix/commits/main) and
[GitHub releases](https://github.com/shmulikdav/Solix/releases).

[1.11.3]: https://github.com/shmulikdav/Solix/releases/tag/v1.11.3
[1.11.2]: https://github.com/shmulikdav/Solix/releases/tag/v1.11.2
[1.11.1]: https://github.com/shmulikdav/Solix/releases/tag/v1.11.1
[1.11.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.11.0
[1.10.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.10.0
[1.9.3]: https://github.com/shmulikdav/Solix/releases/tag/v1.9.3
[1.9.2]: https://github.com/shmulikdav/Solix/releases/tag/v1.9.2
[1.9.1]: https://github.com/shmulikdav/Solix/releases/tag/v1.9.1
[1.9.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.9.0
[1.8.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.8.0
[1.7.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.7.0
[1.6.0]: https://github.com/shmulikdav/Solix/releases/tag/v1.6.0
