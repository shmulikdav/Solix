# Solix — zero to one

A from-scratch test that proves the headline capability: **real, blocking
human-in-the-loop approvals over a live Claude Code session**, plus the
orchestration visuals and the local-API auth.

The companion script `scripts/demo-zero-to-one.sh` automates everything up to the
interactive part. This file is the checklist of what to run and **what you should
see**.

## Requirements

- **Node ≥ 20** and **pnpm**
- **A real `claude` binary on PATH** — the enforcing gate can only truly block a
  live session.

## One command

From a fresh clone:

```sh
bash scripts/demo-zero-to-one.sh
# or, if you added the script entry:  pnpm demo:zero-to-one
# custom port:  SOLIX_PORT=5454 bash scripts/demo-zero-to-one.sh
```

It runs Phases 0–5 automatically, then prints the Phase 6 instructions and keeps
the server alive until you press Ctrl+C.

## What each phase does — and what you should see

| Phase | Command (run for you) | What you should see |
|---|---|---|
| 0 Preflight | checks node/pnpm/claude + free port | green ✓ for node, pnpm, claude, and "port is free" |
| 1 Build | `pnpm install` (first run) + `pnpm -r build` | "built web UI, server, and CLI" |
| 2 Install | `solix install` | hooks wired; `~/.claude/settings.json` backed up; `~/.solix/token` written |
| 3 Doctor | `solix doctor` | diagnostics pass (hooks, agents, DB) |
| 4 Start | `solix start --no-open` (background) | "server is up at http://127.0.0.1:4242" |
| 5 Galaxy + auth | `solix demo`, then token checks | seeded planets; **`POST /events` without token → 401**, **with token → 200** |
| 6 Live gate | *you drive a real `claude` session* | see below — the payoff |

## Phase 6 — the live approval gate (the payoff)

1. Open **http://127.0.0.1:4242** in a browser.
   - You should see a **sun**, **5 advisor planets** (Compass, Forge, Lumen,
     Argus, Sentinel), and the `solix demo` activity: a planet **pulsing red**
     (permission request), one **bloated/orange** (over budget), and **comet
     streaks** (tool calls).

2. In a **second terminal**, start a gated session:
   ```sh
   cd <the throwaway repo the script printed>
   export SOLIX_GATE_ENABLED=1      # turn the ENFORCING gate ON
   export SOLIX_PORT=4242
   claude
   ```
   > `SOLIX_GATE_ENABLED` must be set in the **`claude`** terminal — the hooks
   > read it from claude's own environment, not the server's.

3. Give `claude` a prompt that uses a gated tool:
   - *"create a file called hello.txt containing hi"* (Write), or
   - *"run `ls -la` and show me the output"* (Bash).

4. **Watch the browser:**
   - a new planet appears for your session;
   - the tool call **blocks** — `claude` visibly waits;
   - a **Decision Queue** card shows the *actual* command / file write;
   - press **Y** to **approve** → the tool runs and `claude` continues;
   - press **N** to **deny** → the tool is blocked and `claude` is told it was
     denied.

5. **Prove it never wedges you (fail-open):** in the claude terminal run
   `unset SOLIX_GATE_ENABLED` and repeat step 3. The same prompt now proceeds
   without blocking — Solix falls back to pure observability. (Same result if
   the server is down.)

## Stopping

Press **Ctrl+C** in the script's terminal. The server stops, the browser flips to
**OFFLINE**, and the throwaway demo repo is removed. Your advisors and missions
persist in `~/.solix/solix.db` for next time. To remove the Claude Code hooks:
`node packages/cli/dist/index.js uninstall`.

## Going deeper

- `SECURITY.md` — the trust model and every gate env var
  (`SOLIX_GATE_POLICY` fail-open/fail-closed, `SOLIX_GATE_TIMEOUT`,
  `SOLIX_GATE_TIMEOUT_MS`, the opt-in sandbox `SOLIX_ENV_SCRUB` /
  `SOLIX_SANDBOX_CMD`).
- `docs/BETA.md` — the tester brief: what to try first, and what is young.
- `solix --help` — every `solix` subcommand.
