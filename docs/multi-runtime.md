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
`PostCompact`, `SessionStart`, `SessionEnd`, `SubagentStart` — wrapping its
output in the same `hookSpecificOutput` envelope Claude Code uses.

**The vocabulary inside that envelope is not uniformly the same, and this
sentence used to say it was.** `PreToolUse` does take Claude Code's flat
`permissionDecision`; `PermissionRequest` does not — it reads a nested
`decision.behavior` instead (see below). Reading "same vocabulary" as "same
everywhere" is what sent the first version of the probe at the wrong field.

Its own error strings settle what `PreToolUse` does:

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

### `PermissionRequest` can approve — documented, not yet observed

This section used to say it was unknown whether `PermissionRequest` could
affirmatively approve, and planned to find out by returning each
`permissionDecision` value in turn. **That plan was aimed at the wrong
field.** `PreToolUse`'s flat `permissionDecision` is not what
`PermissionRequest` reads; it takes a nested decision object:

```json
{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}
```

with `{"behavior":"deny","message":"…"}` to refuse. Had the probe gone out as
written, every value would have come back unsupported and this file would now
record "Codex cannot approve" — a false negative with clean output behind it.

Per the [Codex hooks docs](https://developers.openai.com/codex/hooks),
`PermissionRequest` *"can allow the request, deny the request, or decline to
decide and let the normal approval prompt continue"*; *"an `allow` lets the
request proceed without surfacing the approval prompt"*; and across several
hooks, *"any `deny` wins"*. A flat `decision: "approve"` is parsed but not
supported, and `updatedInput`, `updatedPermissions` and `interrupt` fail
closed here.

**This is a documented behaviour and nothing more.** It is the same class of
evidence as the gate that was unit-tested, documented and off in 1.15.0,
1.17.0 and 1.18.0. `docs/CODEX-PROBE.md` is the run sheet that settles it on
the binary, with `scripts/probe-codex-gate.sh` and its hook config.
**Until a run of it passes with its control refusing, no site copy or README
line may claim the Codex gate holds for a human decision.**

### Two hooks, two jobs — and the scope limit that holds regardless

| hook | fires on | decisions | role |
|---|---|---|---|
| `PreToolUse` | every local tool call | **deny only** | the command denylist (a floor only refuses) |
| `PermissionRequest` | only calls **Codex** escalates | allow / deny / abstain | the human hold |

The docs are explicit that `PermissionRequest` *"doesn't run for commands that
don't need approval"*. So **Solix's own notion of risky cannot drive it.** A
command Solix would hold, but Codex does not escalate, can be refused at
`PreToolUse`, or held there and then not-denied — it cannot be
held-then-approved. Even in the best case the Codex human gate covers
escalations, not everything, and that is narrower than the Claude Code gate.

### Hook trust is a problem for `solix install --codex`

Non-managed hooks must be reviewed and trusted through `/hooks` before Codex
will run them, and trust is recorded **against the hook script's hash** — so a
new or changed script is marked for review and skipped until re-trusted.

That means every Solix upgrade which touches a Codex hook script would
silently turn the Codex gate off until the user noticed. Claude Code has no
equivalent; the hook version stamp that `solix doctor` checks covers a much
milder version of the same failure. Any `--codex` installer has to either use
managed hooks (`requirements.toml`) or tell the user, loudly, to re-trust
after an upgrade — and `doctor` needs a check for it. Run 5 of the probe
measures how silent the failure actually is.

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
