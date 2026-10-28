# Solix 1.18.0 — what to try, and what is young

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
about to write before it writes it, backs the file up, and `solix uninstall`
removes all of it. If you would rather it touched nothing yet:
`solix start --no-wire`.

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

**Plan editing is half there.** Maestro turns a goal into a task list and
you get one button: *Approve & run*. You can now retry a failed or escalated
task, and delete a plan you are done with — but you cannot reorder, retitle,
retarget a model, drop a task or add one. The server endpoints for all of
that ship; the frontend calls two of them.

**Share doesn't share.** It does file import/export of a galaxy manifest. The
publish-and-browse half exists on the server and has no UI.

**Routines cannot be edited.** A typo in a cadence means delete and recreate,
which loses the run history and rotates the webhook token. (Bad cadences are
at least now refused rather than silently firing hourly.)

**Orgs are not fully tenanted** — routines are not org-scoped.

**It is desktop-only.** No responsive layout at all. On a phone the rail eats
the screen and the List table is clipped with no horizontal scroll.

**It has not been tuned for a large fleet.** With a few hundred sessions the
galaxy will struggle: no selector memoisation, no virtualised list, a DOM
node per planet. The List view's collapse-by-project helps. This is known and
unaddressed.

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
- **The Fleet panel could not tell you when something went wrong.** Every
  write in Connections — a credential store, where secret values are
  write-only and so a failed write is unrecoverable — was fire-and-forget
  with no status check, and the `Test` button rendered no result either way.
  A list that failed to load rendered as "you have none". Fixed, in all of
  them: writes report, Test says whether it was delivered, and a failed load
  says so and offers a retry.

718 tests, and each of those fixes was proven by reinstating the bug and
watching the tests fail.

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

`Report a problem` in the bottom-left of the rail sends me the payload and
shows you exactly what it contains before it goes anywhere.
