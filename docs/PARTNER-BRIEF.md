# Solix 1.18.3 — what to try, and what is young

A note to go with the build, written to be read before you open it.

Solix is a local control plane for Claude Code agents: every session shows up
as a planet, risky commands are held until you approve them, and spend is
tracked per agent. No account, no telemetry, MIT.

This is a pre-launch build sent for an honest read. What follows is the part
most briefs leave out — where it is thin — because you will find it anyway
and I would rather you found it here.

---

## Install

```sh
npm i -g @shmulikdav/solix
solix
```

First run wires hooks into `~/.claude/settings.json`. It tells you what it is
about to write before it writes it, and backs the file up first.
`solix uninstall` puts your Claude config back exactly as it found it —
checked by diffing it against the original, including hooks of your own
alongside ours — and keeps `~/.solix`, where your session history lives, so
you can delete that yourself or not. If you would rather it touched nothing
yet: `solix start --no-wire`.

If you use **nvm** and Solix cannot find `claude`, set `SOLIX_CLAUDE_BIN` to
the path `which claude` prints in the shell where it works. That is the one
environment problem that still bites.

Nothing to look at yet? `solix demo` seeds a full galaxy with fake data,
clearly badged **DEMO DATA**, against a sandbox database.

---

## The twenty minutes that matter

**The gate is the product. Everything else is a view onto it.** If you only
do one thing, do this:

```sh
solix level strict
```

Then launch a task from the UI (**＋ New task**) and ask the agent to do
something you would not want done unsupervised — delete a directory, force-
push, rewrite a config. Solix should hold it and wait for you.

Three things worth checking while you are there:

1. **Deny actually prevents it.** Not "reports it" — prevents it. The agent
   is told a person decided, so it should not reword the command and retry.
2. **It fails closed.** Kill the Solix server mid-hold. The agent should be
   refused, not waved through. This is the property I would not ship without.
3. **Walk away mid-hold.** Click `notify me` in the top bar first. You should
   hear about it rather than coming back to a stalled agent.

Then open **Mission Control** (the sun, or `W`) for what it cost.

The dial is `solix level observe|standard|strict`. The command denylist —
`rm -rf /`, fork bombs, piping the internet into a shell — is *not* on the
dial and refuses at every level, including `observe`.

---

## What is young

Named deliberately. These are real, they are known, and none of them is a
surprise to me.

**Share doesn't share.** It does file import/export of a galaxy manifest. The
publish-and-browse half exists on the server and has no UI.

**Orgs are not fully tenanted** — routines are not org-scoped.

**It is desktop-only.** No responsive layout at all. On a phone the rail eats
the screen and the List table is clipped with no horizontal scroll.

**It has not been tuned for a large fleet.** With a few hundred sessions the
galaxy will struggle: no selector memoisation, no virtualised list, a DOM
node per planet. The List view's collapse-by-project helps. This is known and
unaddressed.

### Two things this list used to say

Both were closed in 1.18.3. They are here rather than deleted because what
each one now refuses is worth knowing before you try it.

**Plan editing is whole.** It used to be half there — the server endpoints
shipped and the frontend called two of them. Reorder, retitle, re-prompt,
change the acceptance criteria, retarget the model, drop a task, add one.

Two refusals, both deliberate. A task an agent is **currently running** cannot
be edited — abort the plan or let it settle. And a task that has been
**verified** cannot have its terms changed, because "verified against its
acceptance criteria" would stop meaning anything if the criteria could move
afterwards; add a follow-up task instead.

Building it found the hole underneath: that route would previously accept a
rewrite of a verified task's acceptance criteria, and would let a task be
marked `completed` without ever running. Loopback-only, so never exploitable
from outside — but one text field away from being a feature.

**Routines are editable.** It used to be that a typo in a cadence meant delete
and recreate, losing the run history and rotating the webhook token. **Edit**
on a routine card changes its name, prompt, cadence and owner in place: the
row keeps its id, so its history still points at it, and keeps its token, so a
URL already wired up keeps firing. A cadence change tells you what it will
cost before you save, and counts from the save rather than the last run, so
shortening an interval cannot set off an immediate run. One refusal: the
**trigger** cannot change, because a webhook routine's URL is bound to its
kind.

In both, a refused control stays visible and goes grey with the reason in the
tooltip, so you can tell a refusal from a bug.

---

## Where it has been hardened

This build is the output of a deliberately harsh audit. Four classes of
defect were found and closed, and it is worth knowing what they were, because
it tells you what kind of bugs this codebase produces:

- **It could overwrite your Claude Code config.** A malformed
  `settings.json` was replaced with Solix's hooks alone. Fixed — install now
  refuses to write a file it could not read.
- **Approvals were not confirmed.** A decision dropped by a reconnecting
  socket looked identical to a successful one. Fixed — the card stays until
  the server acknowledges it, and the 5-minute timeout now announces the
  denial it was making quietly.
- **Terminate did nothing.** It was a `break;` statement. Fixed.
- **Several figures were invented.** `$0.00` cost-per-mission beside real
  spend, `0%` context with no data, an intervention count capped at 600.
  Fixed — it shows an em dash where it has no data.
- **"Review changes" could show you your own work as the fleet's.** When a
  plan had no captured base commit the diff fell back to `HEAD`, silently.
  Fixed — it now says so, loudly, and names the base when it has one.
- **"Open preview" was offered where it could not work**, including for Node
  and Python projects, and landed on an HTTP 200 dead end in a popup with no
  back button. Fixed — the button appears only when there is something to
  serve, opens a real tab, and the fallback is a 404 with a way back.
- **The command denylist only guarded Maestro's agents.** `rm -rf /`, a fork
  bomb and `curl | sh` were refused for workers and verifiers, and not for a
  New task you launched — which at `observe` meant not at all. Both the
  README and the UI said otherwise. Fixed: the floor applies to everything
  Solix launches, at every level.
- **The Fleet panel could not tell you when something went wrong.** Every
  write in Connections — a credential store, where secret values are
  write-only and so a failed write is unrecoverable — was fire-and-forget
  with no status check, and the `Test` button rendered no result either way.
  A list that failed to load rendered as "you have none". Fixed, in all of
  them: writes report, Test says whether it was delivered, and a failed load
  says so and offers a retry.

- **Stopping Solix left the agent hanging** — found in 1.18.0 by walking
  this note's own step 2, and fixed in **1.18.1**. Killing the server
  mid-hold did fail closed: nothing destructive ran, the canary file
  survived every run. But `Ctrl+C` did not quit while anything was held,
  and the agent waited five minutes before being refused, because a held
  decision is an open connection the shutdown was waiting on — and so was
  your open browser tab. It now refuses what it is holding, says so, and
  exits in about 200ms. If you are on 1.18.0, this is the one thing in here
  you will see misbehave.

- **The two commands you meet first had no tests at all.** `solix demo` and
  `solix doctor` — 1,200 lines between them — and both were producing this
  release's recurring defect, a sentence with nothing behind it. The demo
  checked one preflight event and discarded every write after it, so "seed
  complete: 30 sessions across 8 projects" could print over a seed that had
  mostly failed; the status mix it printed was a hardcoded sentence rather
  than the plan it actually ran; and `--no-ticker`, documented as "seed once
  and exit" and used for screenshots, never exited — it hung, and Ctrl+C
  killed the sandbox you were about to capture. Fixed, with 32 tests — and
  then by running the command, which showed the first fix was incomplete and
  that the demo had been seeding one planet more than it claimed.
- **`solix doctor` looked on the wrong port.** It had no `--port` of its own,
  so after `solix start --port 5000` the one command you run to find out what
  is wrong reported your running server as down and told you to start it.
  Worth knowing because it changes what a red line there means: if you are on
  a non-default port, pass `--port` to `doctor` too.
- **An empty `SOLIX_PORT` could turn the gate off.** Thirteen places read that
  variable and all of them mishandled it being *set but empty* — `??` fires
  only on null and undefined, so `SOLIX_PORT=` read as port **0**. `solix
  start` would bind a random free port and publish "0" to the hooks, which
  would call port 0, find nothing, and fail-closed on every tool call: safe,
  and useless, with no decision card ever appearing. Same class as the
  `--port` defect found in 1.15, by a different road. One parser now, in one
  place.

- **Four numbers it published that nothing guaranteed.** The context
  percentage was the worst: nothing persisted it, so every advisor was told
  the session it was looking at sat at `0%`, and `solix demo` — hardcoding 62
  and 89 — was the only thing in the product that ever wrote one. `solix
  ledger` and the signed fleet report counted at most 1000 audit rows of any
  kind and printed that as the window's total. Spend held at budget pauses
  was added again every time a plan re-paused. And a session on a context
  window larger than the 200K anchor reported a confident 100%, which told
  the model to suggest `/compact` on a session nowhere near full. All four
  fixed, and where there is no measurement you now get an em dash rather than
  a zero.
- **The galaxy leaked while you watched it.** Every context update built a
  new compiled shader and nothing ever released it, and every store event
  re-rendered every planet. Both fixed. Worth knowing because the leak grew
  with event volume rather than fleet size, so it did not need a big galaxy
  to matter — which bears directly on question 4 below.

- **Agent View could tell you a running agent had finished.** One failed
  directory read made Solix mark every mirrored background session
  `terminated`, which the UI renders as "Done" — asserting completion from
  the absence of a reading. And a status string it did not recognise showed
  as a calm `idle` rather than as unknown. Both fixed.
- **A routine you switched off would still run** if you clicked **Run now**,
  because the fire route never checked — while the webhook route for the
  same routine refused it. "Disabled" now means disabled from every surface,
  and "fired" is only reported when the launch actually started.
- **The timeline never fetched its most recent events** in a busy window, so
  scrubbing to the end of a playback showed you the system as it was some
  minutes earlier, under a label saying "last 30 min".

1050 tests, and each of those fixes was proven by reinstating the bug and
watching the tests fail. **Nine of those proofs did not work first time** —
the test had set up a case where the broken and the fixed code agree — and
were rewritten until they failed for the right reason. That count is in here
deliberately: a test that cannot fail is the same defect as a sentence with
nothing behind it, and apparently just as easy to write.

This build was also installed from a packed tarball into a clean machine and
put through the twenty-minute sequence above before being sent to you: the
gate held, deny prevented it, killing Solix mid-hold refused the held call
in 24ms, and the canary survived all of it.

---

## What I would like from you

Most useful, in order:

1. **Did the gate hold, every time?** Anything that got through is the most
   important thing you could tell me.
2. **What did you reach for that wasn't there?** Not "what's broken" — what
   you expected to exist.
3. **Where did you stop trusting it?** If a number looked wrong or a claim
   did not hold, I want that moment specifically.
4. **Would you leave it running?** And if not, what would have to change.

Not worth your time reporting: anything in the "young" list above, visual
polish, or mobile.

**Come straight to me, not to the issue tracker.** This is a private
evaluation and I would rather read it than have it filed in public — just
reply to the message this note came with.

`Report a problem`, bottom-left of the rail, is still the quickest way to
gather the context: it collects the version, platform and recent errors,
shows you the whole payload first, and **Copy details** puts it on your
clipboard. Paste that into your reply. Nothing leaves your machine on its
own — the other button opens a public GitHub issue, so don't use it for
this.
