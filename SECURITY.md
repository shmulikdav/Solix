# Security model

This document covers the mechanics: the hooks, the fail policy, sandboxing
and the local API. **For what the gate does and does not guarantee — and why
approval rules are not a sandbox — read [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md)
first.**

## TL;DR

Solix is a **human-in-the-loop gate** on top of Claude Code's own permission
system. Whether it enforces depends on who started the agent: the agents Solix
launches (Maestro, New task, routines) and `solix gate` runs are gated
**fail-closed**; a `claude` you start yourself is observed and costed, not
gated, unless you opt in. It does **not** sandbox anything by itself.

| Feature | Default | Turn on with |
|---|---|---|
| Enforcing approval gate (Deny actually blocks the tool) | **on, fail-closed** for agents Solix launches and `solix gate`; **off** for a `claude` you start yourself | automatic; `SOLIX_GATE_ENABLED=1` for your own sessions |
| Sandbox/env isolation for Solix-launched agents | **off** | `SOLIX_ENV_SCRUB=1` and/or `SOLIX_SANDBOX_CMD=…` |
| Shared-secret auth on the local ingestion API | **on after `solix install`** | automatic (`~/.solix/token`) |

## How approvals work

Claude Code runs the agents. `solix install` wires hook scripts into
`~/.claude/settings.json`; they POST events to the local server
(`127.0.0.1:4242` by default), which the browser renders.

**Default (observational).** The hooks are fire-and-forget (`curl --max-time 1
… || true; exit 0`) so Solix can never wedge or block your agent if the
server is down. In this mode the Decision Queue's Approve/Deny updates Solix's
UI state and writes an audit row, but the actual allow/deny boundary is Claude
Code's own `settings.json` allow/deny rules — **Deny in the browser does not
block the tool.**

**Enforcing gate (`SOLIX_GATE_ENABLED=1`).** The three sensitive PreToolUse
hooks (Bash, file writes, Task) become a **synchronous gate**: they POST to
`/events/permission` and *block* until you Approve/Deny in the browser, then
return Claude Code a real `permissionDecision` of `allow`/`deny`. Now Deny
actually blocks the tool, and Approve releases it.

> Trade-off: with the gate on, **every** matched tool call waits for a human.
> That's deliberate (it's a human-in-the-loop gate) but noisier than the default.
> To gate only some tools, remove the hooks you don't want from
> `~/.claude/settings.json` (e.g. leave `pre-tool-task` unmanaged to not gate
> subagent spawns).

### Fail policy

When the gate is on but the server is unreachable or no one answers in time, the
hook applies a configurable policy so you're never silently stuck:

| Env var | Default | Meaning |
|---|---|---|
| `SOLIX_GATE_POLICY` | `fail-open` | `fail-open` → defer to Claude Code's normal flow (never wedges). `fail-closed` → deny on outage/timeout. |
| `SOLIX_GATE_TIMEOUT` | `305` | Hook-side timeout (seconds); the curl `--max-time`. |
| `SOLIX_GATE_TIMEOUT_MS` | `300000` | Server-side hold timeout (ms). Keep it shorter than `SOLIX_GATE_TIMEOUT` so the server's policy-aware answer wins. |
| `SOLIX_HOST` / `SOLIX_PORT` | `127.0.0.1` / `4242` | Where the hook reaches the server. |

The gate only works when the machine running `claude` can reach the Solix
server — i.e. same host, or a reachable `SOLIX_HOST`/`SOLIX_PORT`.

## Sandboxing of launched agents

This covers only sessions **Solix launches itself** (the `+ Task` / pinned /
heartbeat paths), not externally-run `claude`.

- **Env isolation (`SOLIX_ENV_SCRUB=1`).** By default a launched agent inherits
  Solix's full environment. With scrubbing on, it gets only an allowlist
  (`PATH`, `HOME`, locale, proxy vars, `SOLIX_*` gate vars) plus anything matching
  `ANTHROPIC_*` / `CLAUDE_*` (so auth still works). Add extras with
  `SOLIX_ENV_PASSTHROUGH=FOO,BAR`. This stops unrelated host secrets from leaking
  into agent subprocesses. (Implied automatically when `SOLIX_SANDBOX_CMD` is set.)
- **Sandbox wrapper (`SOLIX_SANDBOX_CMD=…`).** When set, Solix wraps the spawned
  `claude` with your command, e.g. `bwrap --bind "$PWD" "$PWD" --unshare-net …`
  (Linux) or `sandbox-exec -f profile.sb` (macOS). Solix provides the injection
  point; you supply the jail. Unset → no wrapper (no behavior change).

Full OS-level confinement is **out of scope** — this is env isolation plus an
injection point, not a complete jail.

## Local API authentication

`solix install` generates a random token at `~/.solix/token` (mode `0600`).
Hooks send it as `X-Solix-Token`, and the server requires it on the spoofable
ingestion endpoints (`/events`, `/events/permission`). This stops an arbitrary
local process from injecting fake events or answering gates. The browser never
calls those endpoints (it uses the WebSocket), so the UI is unaffected. Installs
that predate the token simply have no enforcement until you re-run
`solix install`.

CORS is restricted to the known localhost origins. The server binds to
`127.0.0.1` only and is never internet-exposed.

### Known limitations

- The WebSocket itself is not yet token-gated (loopback-only + ingestion-token
  is the v1 boundary).
- The token is local; a `claude` session on a *different* host can't read it, so
  the gate is effectively same-host for now.
- The enforcing gate depends on Claude Code honoring the PreToolUse
  `permissionDecision` contract.

## Reporting

**A security problem — anything that let an agent do something the gate
should have stopped, or let anything other than you read or drive your local
Solix — must not go in a public issue.** Report it privately through GitHub:

**https://github.com/shmulikdav/Solix/security/advisories/new**

Include the Solix version (`solix --version`), the platform, the exact
command or tool call, and what you expected the gate to do. `solix rules test
"<command>"` output is ideal: it shows what the rules decided and why. A
confirmed bypass is fixed with a claim in [`docs/CLAIMS.md`](docs/CLAIMS.md) —
a test that fails if the bypass ever comes back — and credited in the release
notes unless you would rather it was not.

Anything else — a bug, a wrong number, a gap — is welcome as a public issue:
https://github.com/shmulikdav/Solix/issues/new/choose
