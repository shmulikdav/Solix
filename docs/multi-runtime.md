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
| **Codex** | **Experimental** | **Experimental** | **No.** Written against Codex's documented event stream and never executed against the real binary. |

## The gate does not cover Codex

Worth stating plainly, because the rest of this page is about observation
and dispatch and a reader could reasonably assume governance came along for
the ride.

Every hook in `packages/cli/hooks/` is a Claude Code hook, registered in
`~/.claude/settings.json`. There is no Codex equivalent, and `PreToolUse` is
where the gate lives — so a Codex worker dispatched by Maestro receives
`SOLIX_GATE_ENABLED=1` in its environment, nothing reads it, and **neither
the human gate nor the command denylist applies to it**. Solix will observe
what it reports and price its tokens; it will not stop it.

This is reasoning from the code, not a live result — `codex` was not
installed on the machine where it was checked — so treat it as the expected
behaviour rather than a verified one, and the conservative assumption either
way.

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
