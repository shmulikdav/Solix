#!/bin/sh
# Solix PreToolUse hook — Task (subagent spawn).
#
# Two modes:
#   default (SOLIX_GATE_ENABLED != 1): fire-and-forget observability. Posts the
#     event and exits 0 immediately — never blocks Claude Code (same as before).
#   gate    (SOLIX_GATE_ENABLED = 1):  BLOCKS until a human approves/denies in
#     the Solix browser, then returns Claude Code a real allow/deny decision.
#     Note: gating Task blocks subagent *spawn*. Leave this hook unmanaged in
#     settings.json if you want to gate only Bash + file writes.
#
# Fail policy (gate mode, when the server is unreachable or times out):
#   SOLIX_GATE_POLICY=fail-open  (default) -> defer to Claude Code's own flow
#   SOLIX_GATE_POLICY=deny|fail-closed|closed -> deny (what Solix injects)
SOLIX_HOST="${SOLIX_HOST:-127.0.0.1}"
SOLIX_PORT="${SOLIX_PORT:-4242}"
EVENT="pre_tool_task"
PAYLOAD=$(cat 2>/dev/null || echo '{}')
[ -z "$PAYLOAD" ] && PAYLOAD='{}'
TS=$(($(date +%s 2>/dev/null || echo 0) * 1000))
TOKEN=$(cat "${SOLIX_HOME:-$HOME/.solix}/token" 2>/dev/null || echo "")
BODY="{\"event\":\"$EVENT\",\"payload\":$PAYLOAD,\"pid\":$PPID,\"cwd\":\"$(pwd)\",\"ts\":$TS}"

if [ "$SOLIX_GATE_ENABLED" != "1" ]; then
  curl -s -X POST "http://$SOLIX_HOST:${SOLIX_PORT}/events" \
    -H "Content-Type: application/json" \
    -H "X-Solix-Token: $TOKEN" \
    -d "$BODY" \
    --max-time 1 > /dev/null 2>&1 || true
  exit 0
fi

SOLIX_GATE_POLICY="${SOLIX_GATE_POLICY:-fail-open}"
SOLIX_GATE_TIMEOUT="${SOLIX_GATE_TIMEOUT:-305}"
RESP=$(curl -s -X POST "http://$SOLIX_HOST:${SOLIX_PORT}/events/permission" \
  -H "Content-Type: application/json" \
  -H "X-Solix-Token: $TOKEN" \
  -d "$BODY" \
  --max-time "$SOLIX_GATE_TIMEOUT" 2>/dev/null)
CURL_RC=$?
DECISION=""
if [ "$CURL_RC" -eq 0 ]; then
  DECISION=$(printf '%s' "$RESP" | sed -n 's/.*"decision"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p')
fi

case "$DECISION" in
  allow)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"Approved in Solix"}}'
    exit 0
    ;;
  deny)
    printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"A person reviewed this exact command in Solix and denied it. This was a deliberate decision, not a transient failure or a sandbox limitation. Do NOT retry it, and do NOT reword it to achieve the same effect another way - a rephrased retry will be denied again and wastes the attention of the person reviewing. Stop, explain what you were trying to accomplish and why you believe it is needed, and let the person decide."}}'
    exit 0
    ;;
  *)
    # Accept every fail-closed spelling. The launcher injects `deny`
    # (containmentGateEnv), while this hook historically only matched
    # `fail-closed` — so a Solix-launched worker silently FAILED OPEN on an
    # unreachable/timed-out gate, which is the exact case the guarantee is for.
    case "$SOLIX_GATE_POLICY" in
      deny|fail-closed|closed)
      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Solix gate unavailable (fail-closed)"}}'
        ;;
    esac
    exit 0
    ;;
esac
