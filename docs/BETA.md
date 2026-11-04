# Solix beta — what to try, and what is young

A note to go with the build, written to be read before you open it.

**Solix is a local control layer for Claude Code agents.** It does three things:
- It **holds** risky commands from the agents it launches until a person approves them.
- It shows every session on your machine with what it costs.
- It can take a goal, split it into tasks, run and check them, and hand you the diff.

There's no account and no telemetry, and it's MIT-licensed.

This is a private beta. What follows includes the part most briefs leave out, where it is thin, because you'll find it anyway and I'd rather you found it here.

**You need 1.20.4 or later.** Check with `solix --version`. Earlier 1.20 builds have a known hole in the approval rules, and 1.20.3 has the session-count and upgrade problems fixed in 1.20.4. Both are described under *Where it has been hardened*.

---

## Install

```sh
npm i -g @shmulikdav/solix
solix
```

Requirements:
- macOS, Linux, or Windows **through WSL**. Native Windows isn't supported: the hooks are POSIX shell scripts.
- Node 20 or later.
- Claude Code installed.

**What first run does.** It wires nine hooks into `~/.claude/settings.json`. It tells you what it's about to write before it writes it, and backs the file up first.

**Undoing it.** `solix uninstall` puts your Claude config back exactly as it found it, including any hooks of your own. It keeps `~/.solix`, where your session history lives, so deleting that is your choice. If you'd rather it touched nothing yet, run `solix start --no-wire`.

**If you use nvm** and Solix can't find `claude`, set `SOLIX_CLAUDE_BIN` to the path that `which claude` prints in a shell where it works.

**Nothing to look at yet?** `solix demo` seeds a full galaxy with fake data, badged **DEMO DATA**, in a sandbox database. It costs nothing.

### Upgrading from an earlier Solix

`npm i -g` updates the command, but **a Solix server that's already running keeps running the old version.** Restart it on the new one:

```sh
solix stop && solix
```

If the server you're replacing is older than 1.20.4, `solix stop` finds it through `lsof`. If `lsof` isn't installed, it tells you to stop the server with Ctrl+C in its terminal. A second `solix` on a busy port now tells you which version is running there.

The version in the top-left of the UI should match `solix --version`. If you have run Solix before, your earlier history and settings are kept.

---

## Before you start: two things that surprise people

**1. Solix governs the agents it launches, not the `claude` you start yourself.** A session you start in your own terminal shows up and is costed, but it isn't held. Solix can only gate an agent whose environment it set before the agent started.

To test the gate, launch work **from Solix**: **＋ New task**, Maestro, or `solix gate`. If you want your own terminal sessions gated too, start them with `SOLIX_GATE_ENABLED=1` exported.

**2. Some of this spends real money.** New task, Maestro and routines run Claude on **your** account. Maestro also runs a second agent to check each task, so expect about three times what plain Claude Code costs for the same job. Give a plan a **budget cap**: it pauses before it spends past it.

---

## The twenty minutes that matter

**The gate is the product. Everything else is a view onto it.** In order:

### 1 · Watch it hold, deny, and fail closed (about 5 minutes)

1. Make a scratch folder with a file in it you'd miss, for example `canary/keep.txt`.
2. Click **＋ New task**, point it at that folder, and ask the agent to delete `canary/`.
3. Solix should **hold** the call, with the exact command in front of you, under **Decisions**.

Three things to check while you're there:
- **Deny actually prevents it.** Not "reports it": prevents it. The agent is told a person decided, so it shouldn't reword the command and try again.
- **It fails closed.** Ask again, and while the call is held, stop the Solix server (Ctrl+C in its terminal). The agent should be refused, not waved through. This is the property I wouldn't ship without.
- **Walk away mid-hold.** Click **notify me** in the top bar first. You should hear about a held call rather than come back to a stalled agent.

### 2 · Make it ask less (about 5 minutes)

A gate that asks about everything gets switched off. Run:

```sh
solix rules defaults
```

This installs a short allow-list of standing decisions:
- reading inside the project;
- writing inside the project;
- listing, testing, committing.

It allows nothing that deletes, pushes, escalates or fetches. Run step 1 again with an ordinary task and count how often you're asked.

On a Decisions card, **Always allow …** turns one answer into a rule. **Fleet → Rules** lists your rules with how often each fired.

To see what the gate would do with any command, without running an agent:

```sh
solix rules test "cat package.json | head -60"
solix rules test "cat ~/.ssh/id_ed25519"
```

The first is allowed. The second isn't, and it tells you why.

### 3 · Hand Maestro a small goal (about 10 minutes)

**Maestro** in the left rail:
1. Pick a project, describe a small goal, and set a **budget cap**.
2. Maestro proposes a plan, and nothing runs until you approve it.
3. It runs one agent per task, has a second agent check each result against its acceptance criteria, retries with feedback, and sends a task to you if it keeps failing.
4. When it's done, **review the diff**.

Then open **Mission Control** (click the sun, or press `W`) for what it all cost.

### Optional · Run an agent in CI, with nobody at the gate

```sh
cat > policy.json <<'EOF'
{ "extends": "defaults", "rules": [
  { "tool": "Bash", "match": "command_regex", "value": "^npm (pack|publish) --dry-run$" }
] }
EOF
solix gate --rules policy.json -- claude -p "Run the tests and tell me what fails"
```

- **What gets refused:** anything the policy doesn't cover is refused at once instead of waiting for a person.
- **The exit code:** `3` if anything was refused.
- **What you're left with:** `solix-gate/` holds the audit trail and a signed report.

The CI example is in [`docs/GATE.md`](GATE.md).

---

## What is young

Named deliberately. These are real and known, and none of them is a surprise to me. There's no need to report them, but tell me if one of them stops you.

- **A very large live fleet hasn't been tuned.** Quiet history is hidden now (see below), but hundreds of sessions *working at once* would still strain the galaxy, and List isn't virtualised.
- **Sessions on another machine** (hooks pointed at a remote Solix) are never retired automatically. Solix can only check processes on its own machine.
- **Approval rules are not a sandbox.** Allowing `npm test` allows whatever your tests do. Only Bash, Read, Write, Edit, MultiEdit and Task go through Solix's gate, and Solix doesn't control the network. For untrusted work, run the agent in a container. [`docs/THREAT-MODEL.md`](THREAT-MODEL.md) is the full picture, and is worth five minutes.
- **The headline number is pre-release.** On the last measured run, default rules took a test task from 30 holds to 4. Changes since then are proven by tests but not yet re-measured on a real machine.
- **No update notice.** Solix doesn't phone home, so it won't tell you a newer version exists. I'll tell you directly when a fix matters.
- **Share doesn't share yet.** It imports and exports a galaxy as a file. The publish-and-browse half has no UI.
- **Orgs aren't fully tenanted.** Routines aren't scoped by org.
- **Desktop only.** No phone layout.
- **Codex support is experimental,** and the gate doesn't cover Codex.

---

## Where it has been hardened since the last brief

The last brief went out with 1.18.3. Since then:

**New in 1.20.4, found by running it on a machine with months of history:**

- **A session ends when its `claude` does.** Solix used to miss session ends, so a machine showed "17 active · 464 idle" with a handful of agents running. Sessions whose process has ended are now retired within a minute, and the count is true.
- **The galaxy stays readable.** Idle sessions quiet for over a day are hidden, with a visible "N quiet sessions hidden · Show". Anything working, waiting on you, or recent is never hidden, and List shows everything.
- **`solix stop`**, and a second `solix` that says which version is already running. Upgrading is `solix stop && solix`.

**Earlier in 1.20:**

- **A hold is the exception now.** Approval rules: standing decisions, consulted after the denylist (which no rule can override) and before anyone is asked.
- **A "no" sticks.** A command a person denies is refused for the rest of that plan. A task whose attempt was denied comes to you instead of retrying. A plan whose question was still open when Solix stopped comes back **paused**, not decided by default.
- **Lowering the dial under running work needs `--force`**: `solix level observe|standard|strict`.
- **A web page can't read your local Solix.** The API now checks the host it was addressed to, which closes a DNS-rebinding read.
- **CI mode (`solix gate`),** with policy files, `solix rules test`, and a signed report.
- **Parallel Maestro** for independent tasks, each in its own git worktree, merged back one at a time. A conflict comes to you instead of being merged silently.

**Three security fixes to the approval rules, found by probing them, in 1.20.1–1.20.3.** The default rules used to auto-allow commands that reach outside your project:

| Example | Fixed in |
|---|---|
| `echo x >~/.bashrc` | 1.20.1 |
| A hand-written regex rule like `^cat ` reading `~/.ssh` | 1.20.2 |
| `Read ~/.ssh/id_ed25519`, `cat $HOME/.aws/credentials`, `cat ../../.ssh/…` | 1.20.3 |

All are fixed, each with a test that fails if it comes back. The denylist (`rm -rf /`, writes to SSH keys, `curl | sh`, `sudo`) ran first throughout. This is why you need 1.20.3 or later; 1.20.4 adds the fixes above.

**1,402 tests.** Every public claim Solix makes is bound to a test that fails when it stops being true. There are 51, listed in [`docs/CLAIMS.md`](CLAIMS.md).

---

## What stays on your machine

Everything. `~/.solix/solix.db` holds:
- your sessions;
- the **prompts you submit** (each becomes a mission title);
- the commands that were held or decided;
- costs.

Nothing is sent anywhere unless you configure it: a Slack or Telegram notifier, or `solix reporting`, which is off by default. `solix uninstall` removes the hooks; delete `~/.solix` to remove the history.

---

## What I would like from you

Most useful, in order:

1. **Did the gate hold, every time?** Anything that got through is the most important thing you could tell me.
2. **Where did you stop trusting it?** A number that looked wrong, a claim that didn't hold: I want that moment specifically.
3. **How often did it ask you, with and without the default rules?** And was each ask worth it?
4. **What did you reach for that wasn't there?** Not what's broken: what you expected to exist.
5. **Would you leave it running, or put it in CI?** If not, what would have to change?

Not worth your time: anything in *What is young*, visual polish, or mobile.

### How to send it

- **The quickest:** reply to the message this brief came with. **Report a problem**, bottom-left of the rail, gathers the version, platform and recent errors and shows you the whole payload first. **Copy details** puts it on your clipboard; paste that into your reply.
- **Public issues are welcome too:** [github.com/shmulikdav/Solix/issues](https://github.com/shmulikdav/Solix/issues/new/choose). Use **"Something didn't hold"** for the trust question above.
- **A security problem** (anything that let an agent do something the gate should have stopped) should **never** go in a public issue. Report it privately: [github.com/shmulikdav/Solix/security/advisories/new](https://github.com/shmulikdav/Solix/security/advisories/new), or reply to me directly.

Thank you for trying it.
