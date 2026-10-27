# GitHub housekeeping — paste-ready

Two things this session cannot do: `"Repository settings writes are not
permitted through this proxy"` and `"Creating, editing, or deleting releases
is not permitted for this session type"`. Both are a couple of minutes by hand.

---

## 1 · Repo settings

**https://github.com/shmulikdav/Solix** → ⚙️ beside **About**, top right.

### Description

Currently **"Agnet Orchestration Space"** — a typo, on a public repo, as the
first line anyone reads. Replace with:

```
The control layer for your coding agents. Every risky command from a Maestro plan is held until you approve it, live cost per session, all on your machine — no account, no telemetry.
```

### Website

```
https://www.solixsys.com
```

### Topics

Currently empty. These are what GitHub search matches on:

```
claude-code
ai-agents
developer-tools
local-first
agent-orchestration
cli
typescript
```

### Discussions

**Settings → General → Features → ☑ Discussions.** Off today, so a question
that is not a bug report has nowhere to go but the issue tracker.

---

## 2 · Releases

The Releases page still shows **v1.9.1, from 2 September**, while npm serves
1.16.0. To anyone checking whether this is maintained, that reads as
abandoned.

Four tags have no notes: v1.13.0, v1.14.0, v1.15.0, v1.16.0. The two worth
writing are below; 1.13.0 and 1.14.0 can be backfilled from `CHANGELOG.md`
or left alone.

### v1.15.0 — the one that matters

**https://github.com/shmulikdav/Solix/releases/new** → choose tag **v1.15.0**.

**Title:**

```
v1.15.0 — the gate actually holds
```

**Body:**

```markdown
Solix held commands for approval in every version before this one, except it
didn't. Running Suite E against a real agent for the first time: a Maestro
worker ran `rm -rf` on a canary directory, the verifier certified it as a
success, and nobody was ever asked — while the front page promised the
command would be held.

`shouldGateContainedRole` returned true only for `strict`, and contained
roles are the only sessions that carry the gate env at all, so at the default
level the human gate was unreachable code. The level's own description had
always read *"sensitive calls from a task Solix launched are held"*. The
contract was right; the implementation never kept it. It shipped that way in
1.12.1, 1.13.0 and 1.14.0.

## Fixed

- **A worker or verifier is now held at `standard`.** It runs from a plan you
  just approved and are watching, so there is someone to ask.
- **A routine is not**, because it fires on a schedule with nobody at the
  keyboard — holding one would stall until the gate timed out and then deny,
  turning every unattended run into a silent failure. `strict` holds those too.
- **`~` is expanded in a project path.** `~/project` reached `spawn({ cwd })`
  literally, and Node reports a missing cwd as `spawn claude ENOENT` — naming
  the command, so it read as a broken Claude Code install.

## Changed

The gate's scope is stated honestly in the README, on the website and in
`docs/E2E-SMOKE-TEST.md`. **A New task launched from the UI is not gated** —
it carries no gate env at any level and keeps Claude Code's own prompt. The
smoke-test doc had listed it as gated, which is why Suite E was run against a
path with no gate and appeared to find a UI fault instead.

**Verified end to end:** the worker stalls, the card shows the exact command,
Deny prevents it, and the canary survives.
```

### v1.16.0 — current

**https://github.com/shmulikdav/Solix/releases/new** → choose tag **v1.16.0**
→ tick **Set as the latest release**.

**Title:**

```
v1.16.0 — what the first real gate run exposed
```

**Body:**

```markdown
Suite E passed on 1.15.0 — a worker was held, denied, and the canary
survived. These are the three things that passing run exposed on the way
past, none of which any test covered.

## Fixed

**A denial told the agent nothing, so it tried again in different words.**
Denied `rm -rf ./canary`, it came back with
`rm ./canary/keep.txt && rmdir ./canary`, three times. Each retry is another
card for a person to read, and the fourth is the one approved out of fatigue.
`permissionDecisionReason` — the only channel back to the model — said
"Denied in Solix", which reads like a transient obstacle. It now says a
person reviewed this exact command and decided, that it is not a transient
failure, and not to reword it.

**The destructive-command hint only matched the obvious spelling.** It tested
for `rm -rf` and `sudo`, so the reworded deletion above drew no warning at
all — and the rephrased form is the one a tired reviewer waves through.
`isDestructive` now covers any `rm`, `rmdir`, `git clean`,
`git reset --hard`, branch deletes, `shred`, `truncate`, `dd of=`,
`find -delete`, docker teardown and truncating redirects. 36 tests, half of
them ordinary commands asserted to stay quiet.

**"2 need you" that opened an empty panel.** Pending requests live in memory
and session status lives in SQLite, so a restart left rows marked
`awaiting_permission` with nothing behind them — permanently. The badge sat
on a stale count while Decisions correctly said "Nothing waiting", and the
natural conclusion was that Decisions was broken. Those holds are now cleared
at startup.

## Verification

Suite E now passes in full against a real agent: a command is held with its
exact text, Deny prevents it, Approve lets it through, the approve keys are
inert while the panel is closed, and **killing the Solix server mid-decision
denies rather than waving through** — the worker reported
*"blocked by a Solix gate PreToolUse hook (fail-closed)"* and the plan failed
honestly.

585 tests, 12 plugin tests, clean-machine rehearsal.
```

---

## Why this is worth the ten minutes

Someone evaluating Solix checks three things: the repo description, whether
releases look alive, and whether anyone else is using it. Right now the first
has a typo, the second looks seven weeks stale, and Discussions is off so
there is nowhere for the third to happen.
