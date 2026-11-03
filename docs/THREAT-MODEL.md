# Threat model

What Solix's gate guarantees, what it does not, and where the real boundary
is. Written for someone deciding whether to let an agent run under it.

**In one line:** Solix asks before your agent does something you have not
already decided about, refuses when nobody answers, and refuses a short list
of catastrophic commands no matter what. It reads each command, but it doesn't
run it, so it isn't a sandbox. For hard isolation, run the agent in one.

---

## Which agents are governed

| Agent | Gated? |
|---|---|
| Maestro workers and verifiers, **New task**, routines | Yes. Solix starts them with the gate on and **fail-closed** |
| `solix gate -- <agent>` (CI) | Yes. Fail-closed, and nobody is at the gate, so anything uncovered is **refused** |
| A `claude` you start yourself | **No.** Solix observes and costs it. It cannot govern an agent whose environment it did not set. Export `SOLIX_GATE_ENABLED=1` before starting it to opt in |

## The layers, in order

Every gated tool call passes through these, top to bottom. The first one that
decides, decides.

1. **The denylist.** A curated list of catastrophic commands: a recursive
   force-delete of `/`, `~` or a system directory, a fork bomb, `mkfs`, raw
   writes to block devices, piping a download into a shell, `sudo`/`su`,
   shutdown/reboot, a world-writable `chmod` or recursive `chown` of `/`, and
   writes to SSH credential files. It is refused at every governance level,
   including `observe`, and **no rule can override it.** It matches text, so
   it's a backstop, not a complete list of everything harmful.
2. **Confinement** (Maestro workers, verifiers and routines). A `Write`,
   `Edit` or `MultiEdit` outside the project directory is refused.
3. **Approval rules.** These are standing decisions a person has made: allow
   `git status`, refuse `git push`. See *What a rule can and cannot see* below.
4. **A person.** Anything else is held, with the exact command shown, until
   someone approves or denies it. A denial is final for the rest of that
   plan. If nobody answers within the timeout (300 s by default), the call is
   **denied**. Under `solix gate` nobody is there, so the call is refused at
   once.

If the Solix server is down or unreachable, a fail-closed hook **denies**.
It never waves a call through.

## What a rule can and cannot see

An allow rule covers a shell command only when **every segment** is covered
(`ls && git push` is not "an `ls`"). The commands inside `$( … )` and
`<( … )` count as their own segments. An allow rule **never covers a path
outside the project or the session scratchpad**, however the path is spelled:

- absolute, `~`, or `~user`;
- `$HOME`, `${HOME}`, `$PWD`, or a variable assigned earlier in the same
  command. A variable the command can't know (set by an earlier call, or from
  `$( … )`) counts as **outside**;
- relative with `..`, resolved from the directory the call runs in;
- a redirect target (`>/x`, `2>/x`, `> ../x`), an option value
  (`--output=/x`, `-o/x`), or a `key=value` argument;
- a symlink inside the project that points out of it;
- for `Read`, `Grep` and `Glob`: the file, the `path`, or a `Glob` pattern that
  leaves the directory.

These are held by `CLAIM-RULES-SEE-EVERY-PATH`, `CLAIM-READS-CONFINED`,
`CLAIM-RULES-SEE-REDIRECTS` and `CLAIM-ALLOW-RULES-CONFINED` in
[`CLAIMS.md`](./CLAIMS.md). Each claim has a test that fails if it stops being
true. `solix rules test "<command>"` shows the gate's own verdict for any
command.

### What no rule can see

**Allowing a program allows everything it does.** The gate sees the command an
agent asks to run, not what that command does once it starts:

- `npm test`, `node --test`, `node build.js`, `make` and `git commit` (which
  runs hooks) run code. That code can read, write and connect anywhere you can.
  The default rules allow running the project's own code, because an agent
  that can't run tests can't do its job. That's a decision about trust, not a
  boundary.
- `node -e "…"` is covered by the default `node` rule. It reaches no further
  than `node file.js` after a `Write` inside the project, which the defaults
  also allow. We kept it rather than pretend the difference is a boundary.
- An alias, function or variable defined in an **earlier** call of a
  persistent shell is invisible to the next one. Defining one is not covered
  by the defaults, so a person would have had to approve it.

**Tools the gate doesn't see.** Only `Bash`, `Read`, `Write`, `Edit`,
`MultiEdit` and `Task` go through Solix's gate. `Glob`, `Grep`, `WebFetch`,
`WebSearch`, `NotebookEdit` and MCP tools are governed by Claude Code's own
permission settings, not by Solix.

**Network.** Solix doesn't control outbound traffic. A program an allowed
command runs can connect anywhere the machine can.

## Where the real boundary is

For anything you wouldn't hand a stranger's script:

- run the agent in a **container** or VM with only the project mounted and
  network egress restricted; or
- use `SOLIX_SANDBOX_CMD` to wrap the agents Solix launches in an OS sandbox
  (`bwrap` on Linux, `sandbox-exec` on macOS). See
  [`SECURITY.md`](../SECURITY.md).

Solix then becomes the part a sandbox can't be: it asks a person before the
risky step, keeps a person's denial final, and records every decision in a
signed ledger.

## The local server

- It binds to `127.0.0.1` only.
- A random token (`~/.solix/token`, mode `0600`) is required on the endpoints
  hooks post to, so another local process can't inject events or answer a
  hold.
- Every API route and the WebSocket check `Host` (against DNS rebinding) and
  `Origin`.
- There is no account and no telemetry.

## What the signed report proves

A `solix gate` report is hash-chained and ed25519-signed by the machine that
ran it. It proves the report came from that machine's key and hasn't been
edited since. It does **not** prove the agent did nothing the hooks didn't
see. See *What no rule can see* above.

## Reporting a vulnerability

See [`SECURITY.md`](../SECURITY.md#reporting). A gate bypass that gets fixed
becomes a claim in [`CLAIMS.md`](./CLAIMS.md), with a test that fails if the
bypass comes back.
