# Multi-runtime agents (Claude Code + Codex)

Solix is runtime-agnostic at the ingestion boundary: one event envelope
(`HookEvent`) and one entry point (`router.handleHookEvent`). State, the galaxy
view, missions, the decision queue and cost/audit are all agent-neutral, so a
second runtime is a normalizer plus a dispatch branch rather than a second
pipeline.

## Status, honestly

| Runtime | Observe (hooks → galaxy) | Dispatch (Maestro workers) | Verified against the real CLI |
|---|---|---|---|
| **Claude Code** | Supported | Supported | Spawn path, env/gate injection, argv, result parsing, cost, abort are covered by an end-to-end test against a stand-in binary (`launcher.integration.test.ts`). The envelope shape is pinned to the documented `SDKResultMessage` arms. A live smoke test against your installed `claude` is still the final check. |
| **Codex** | **Experimental** | **Experimental** | **Partly.** The event normalizer is written against Codex's documented stream and still never run against a live session. What *has* been checked against the real binary (0.166.0) is its hook surface — see below: `PreToolUse` blocks and is deny-only. |

## The gate does not cover Codex — but it now can

**This section said "there is no Codex equivalent" of `PreToolUse`, and
flagged itself as reasoning rather than a live result. The caveat was right
to be there: it is out of date.**

Checked against `codex-cli 0.166.0`, installed and inspected rather than
assumed. Its binary ships a full hook system — `PreModelRequest`,
`PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`,
`PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart` — using the same
`hookSpecificOutput` / `permissionDecision` vocabulary Claude Code uses. Its
own error strings settle what it does:

```
Command blocked by PreToolUse hook:
Tool call blocked by PreToolUse hook:
PreToolUse hook returned unsupported permissionDecision:allow
PreToolUse hook returned unsupported permissionDecision:ask
PreToolUse hook returned permissionDecision:deny without a non-empty permissionDecisionReason
PreToolUse hook cannot change the tool environment
```

So: **`PreToolUse` blocks, it is deny-only, and a deny must carry a non-empty
reason.** Deny-only is exactly what the command denylist needs — a floor only
ever refuses — so the floor can cover Codex with a hook script and no change
to the router's decision logic.

### What is still unknown

Whether **`PermissionRequest` can affirmatively approve**, which decides
whether the *human* gate on Codex is as strong as it is on Claude Code or
weaker.

The binary contains `approve`, `block` and `allow` near a
`PermissionRequestBehaviorWire`, and — unlike `PreToolUse` — its
`PermissionRequest hook returned unsupported …` messages are all about other
fields (`continue`, `interrupt`, `stop`, `suppress`, `updatedInput`) and
never about a decision value. That is suggestive and not proof: a
concatenated symbol table does not say which struct owns which string.

If `PermissionRequest` supports approve, Solix holds there and answers either
way, and the Codex gate means what the Claude Code gate means. If it does
not, "approve" can only mean "do not deny" and Codex's own approval flow
continues — a materially weaker promise that has to be said out loud rather
than inherited by assumption.

**Settle it by running it**, not by reading more strings: register a hook on
an authenticated `codex`, return each decision value in turn, and record
which ones it accepts. Until then no site copy or README line may claim the
Codex gate holds for a human decision.

### A limit that holds either way

Hosted tools (web search and friends) do not pass through the local hook
path, so neither the gate nor the denylist can reach them. A shell command is
covered; a hosted tool is not. That belongs in the ledger before it belongs
on the website.

## What "experimental" means for Codex

- The event normalizer (`server/src/codex.ts`), the `codex exec` argv builder and
  the NDJSON result parser are all written to be **tolerant**: they scan every
  JSON line, accept several text and usage shapes, and ignore unrecognized
  events, so a schema drift degrades to "no text / no cost" instead of throwing.
- Codex reports **token usage, not a dollar figure**, so there is no
  `total_cost_usd` to read. Solix prices the usage locally from
  `shared/src/pricing.ts`. Those rates are approximate — tune them to the model
  you actually run, or your budget caps will be off.
- `solix install --codex` (which would write the Codex hook config for you) is
  **not implemented**. Observing Codex sessions currently requires wiring the
  hooks by hand to POST to `/events/codex`.
- Expect to fix something the first time you point this at a real `codex`. Treat
  the first run as a debugging session, not a demo.

## Overriding the binary

Both runtimes resolve their executable through an env override, for non-standard
installs (nvm shims, custom prefixes, wrapper scripts):

```sh
SOLIX_CLAUDE_BIN=/opt/homebrew/bin/claude
SOLIX_CODEX_BIN=/usr/local/bin/codex
```

Unset, they fall back to `claude` / `codex` on `PATH`.
