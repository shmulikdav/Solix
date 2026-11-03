#!/bin/sh
# Solix — Codex hook probe. Answers one question with the binary rather than
# with reasoning: can Codex's `PermissionRequest` hook AFFIRMATIVELY APPROVE?
#
# It decides whether a human gate on Codex means what it means on Claude Code
# ("a person said yes, proceed") or only means "do not deny", in which case
# Codex's own approval flow continues and the promise is materially weaker.
# Until a run of this says otherwise, no README, site or brief copy may claim
# the Codex gate holds for a human decision.
#
# ## The shape, which is not the PreToolUse shape
#
# `PreToolUse` speaks `permissionDecision: "deny"` and is deny-only: `allow`
# and `ask` are rejected as unsupported. `PermissionRequest` speaks a NESTED
# decision object instead:
#
#   {"hookSpecificOutput":{"hookEventName":"PermissionRequest",
#    "decision":{"behavior":"allow"}}}
#
# The first version of this probe returned `permissionDecision:"approve"` on
# `PermissionRequest` — the PreToolUse vocabulary, plus a legacy value. Every
# run would have come back unsupported and the conclusion would have been
# "Codex cannot approve": a false negative produced by clean output from a test
# aimed at the wrong field. `PROBE_BEHAVIOR=legacy` still sends exactly that,
# on purpose, so a run records that it fails instead of leaving it asserted.
#
# ## Usage
#
#   PROBE_BEHAVIOR=allow|deny|abstain|legacy   what to return (default abstain)
#   PROBE_LOG=/path/to/log                     where invocations are recorded
#                                              (default ~/.solix/codex-probe.log)
#
# The behaviour is read from the environment and NOT edited into the file,
# because Codex records hook trust against the script's hash: a changed script
# is marked for review and skipped until re-trusted, which looks identical to
# "the hook never fired". Run 5 of the run sheet tests that trap deliberately.
#
#   sh scripts/probe-codex-gate.sh --self-test   exercise every branch, no Codex
#
# See docs/CODEX-PROBE.md for the run sheet, and run 0 — the control — without
# which an approved command running proves nothing.

PROBE_BEHAVIOR="${PROBE_BEHAVIOR:-abstain}"
PROBE_LOG="${PROBE_LOG:-${SOLIX_HOME:-$HOME/.solix}/codex-probe.log}"

# Pull one top-level string field out of a JSON blob with sed, the way the
# shipped hooks do (packages/cli/hooks/pre-tool-bash.sh) — no jq dependency,
# since this has to run wherever Codex runs.
json_str() {
  printf '%s' "$2" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
}

# Emit the response for one (event, behaviour) pair on stdout.
# Separated from the I/O so --self-test can assert the exact bytes.
respond() {
  _event="$1"
  _behavior="$2"

  case "$_behavior" in
    abstain)
      # "Decline to decide and let the normal approval prompt continue."
      # Nothing on stdout; plain text would be ignored anyway.
      return 0
      ;;
  esac

  case "$_event" in
    PermissionRequest)
      case "$_behavior" in
        allow)
          printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
          ;;
        deny)
          printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"Denied by the Solix probe."}}}'
          ;;
        legacy)
          # The wrong shape, sent so a run records its rejection.
          printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","permissionDecision":"approve","permissionDecisionReason":"Approved by the Solix probe."}}'
          ;;
      esac
      ;;
    PreToolUse)
      case "$_behavior" in
        allow)
          # Expected to be REJECTED as unsupported — PreToolUse is deny-only.
          # Sent so the run records the rejection rather than assuming it.
          printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Approved by the Solix probe."}}'
          ;;
        deny|legacy)
          # A deny must carry a non-empty reason or Codex reports an error.
          printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Denied by the Solix probe."}}'
          ;;
      esac
      ;;
  esac
}

self_test() {
  _fails=0
  check() {
    _name="$1"; _got="$2"; _want="$3"
    if [ "$_got" = "$_want" ]; then
      printf '  ok    %s\n' "$_name"
    else
      printf '  FAIL  %s\n     want: %s\n      got: %s\n' "$_name" "$_want" "$_got"
      _fails=$((_fails + 1))
    fi
  }

  echo "probe-codex-gate --self-test"

  # The load-bearing one. PermissionRequest approval is a nested decision
  # object; if this ever reads `permissionDecision`, the probe is testing the
  # wrong field and a real run would report a false negative.
  check "PermissionRequest/allow is a nested decision object" \
    "$(respond PermissionRequest allow)" \
    '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'

  check "PermissionRequest/allow does not use permissionDecision" \
    "$(respond PermissionRequest allow | grep -c permissionDecision)" "0"

  check "PermissionRequest/deny carries a message" \
    "$(respond PermissionRequest deny | grep -c '"behavior":"deny","message":"')" "1"

  # A PreToolUse deny with an empty reason is reported as an error by Codex.
  check "PreToolUse/deny carries a non-empty reason" \
    "$(respond PreToolUse deny | sed -n 's/.*"permissionDecisionReason":"\([^"]*\)".*/\1/p' | wc -c | tr -d ' ')" \
    "$(printf 'Denied by the Solix probe.\n' | wc -c | tr -d ' ')"

  # Abstain must be silence. Anything on stdout would be a decision.
  check "abstain prints nothing (PermissionRequest)" "$(respond PermissionRequest abstain)" ""
  check "abstain prints nothing (PreToolUse)" "$(respond PreToolUse abstain)" ""

  # The deliberate wrong shape, so run 4 has something to reject.
  check "legacy sends the PreToolUse vocabulary on PermissionRequest" \
    "$(respond PermissionRequest legacy | grep -c '"permissionDecision":"approve"')" "1"

  check "an unknown event prints nothing" "$(respond SessionStart allow)" ""

  echo
  if [ "$_fails" -eq 0 ]; then
    echo "all checks passed"
    echo "This proves the probe emits the documented shapes. It does NOT prove"
    echo "Codex accepts them — that needs the binary. See docs/CODEX-PROBE.md."
    return 0
  fi
  echo "$_fails check(s) failed"
  return 1
}

case "$1" in
  --self-test) self_test; exit $? ;;
esac

PAYLOAD=$(cat 2>/dev/null || echo '{}')
[ -z "$PAYLOAD" ] && PAYLOAD='{}'

EVENT=$(json_str hook_event_name "$PAYLOAD")
TOOL=$(json_str tool_name "$PAYLOAD")
COMMAND=$(json_str command "$PAYLOAD")

OUT=$(respond "$EVENT" "$PROBE_BEHAVIOR")

# The log is the result. stdout belongs to Codex, and an abstaining run prints
# nothing at all, so without this a run leaves no evidence it happened —
# indistinguishable from a hook that was never invoked or was skipped pending
# trust review.
mkdir -p "$(dirname "$PROBE_LOG")" 2>/dev/null
{
  printf '%s\tbehavior=%s\tevent=%s\ttool=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo unknown)" \
    "$PROBE_BEHAVIOR" "${EVENT:-<none>}" "${TOOL:-<none>}"
  printf '\tcommand: %s\n' "${COMMAND:-<none>}"
  printf '\treturned: %s\n' "${OUT:-<nothing>}"
} >> "$PROBE_LOG" 2>/dev/null

[ -n "$OUT" ] && printf '%s\n' "$OUT"
exit 0
