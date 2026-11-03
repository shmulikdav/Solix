#!/bin/sh
# One Maestro eval run, end to end, against a running Solix.
#
# Measures what the review measured: on the fixed `tally` spec (SPEC.md next to
# this script), how many holds a person is left with, what it cost, how long it
# took, how many interventions it needed, and whether the work passed. Run it
# before every release and put the numbers in the release notes.
#
# Prerequisites (this does NOT run in CI — it needs the real agent):
#   - Solix running on $SOLIX_PORT (default 4242): `solix start`
#   - a real `claude` (or `codex`) on PATH that Solix can launch
#   - `solix` on PATH, for `solix rules defaults` and `solix level`
#
# env:
#   SOLIX_PORT        default 4242
#   SOLIX_EVAL_DIR    where results + the scratch project live (default ./.eval)
#   SOLIX_LEVEL       governance level for the run (default standard)
#   SOLIX_RULES       1 to install `solix rules defaults` first (default 1)
#   SOLIX_BUDGET_USD  plan budget cap (default 8)
#   SOLIX_TIMEOUT_S   give up polling after this many seconds (default 1200)
set -eu

PORT="${SOLIX_PORT:-4242}"
DIR="${SOLIX_EVAL_DIR:-$PWD/.eval}"
LEVEL="${SOLIX_LEVEL:-standard}"
RULES="${SOLIX_RULES:-1}"
BUDGET="${SOLIX_BUDGET_USD:-8}"
TIMEOUT="${SOLIX_TIMEOUT_S:-1200}"
API="http://127.0.0.1:${PORT}/api"
HERE=$(CDPATH= cd "$(dirname "$0")" && pwd)
PROJECT="$DIR/project"

export SOLIX_PORT SOLIX_EVAL_DIR="$DIR" SOLIX_PROJECT="$PROJECT"

echo "[eval] results + project under $DIR"
rm -rf "$DIR"
mkdir -p "$DIR"

# A fresh checkout with only the spec, committed, so the diff is the agent's.
mkdir -p "$PROJECT"
cp "$HERE/SPEC.md" "$PROJECT/SPEC.md"
( cd "$PROJECT" && git init -q && git add -A && git -c user.email=eval@solix -c user.name=eval commit -qm "spec" )

if [ "$RULES" = "1" ]; then
  echo "[eval] installing default rules for the project"
  solix rules defaults --project "$PROJECT" || echo "[eval] (solix rules defaults failed — continuing without)"
fi
echo "[eval] governance level: $LEVEL"
solix level "$LEVEL" >/dev/null 2>&1 || true

# Background: log the websocket, and answer whatever still reaches a person.
node "$HERE/wslog.mjs" &   WSPID=$!
python3 "$HERE/approver.py" & APPID=$!
trap 'kill "$WSPID" "$APPID" 2>/dev/null || true' EXIT
sleep 1

echo "[eval] creating the plan"
GOAL='Build the tally CLI described in SPEC.md in this repository, with tests, and commit it.'
RESP=$(curl -s -X POST "$API/plans/from-goal" \
  -H 'Content-Type: application/json' \
  -d "$(python3 -c "import json,os;print(json.dumps({'goal':os.environ['G'],'cwd':os.environ['P'],'name':'tally eval','budgetUsd':float(os.environ['B'])}))" G="$GOAL" P="$PROJECT" B="$BUDGET")")
PLAN=$(printf '%s' "$RESP" | python3 -c "import json,sys;print(json.load(sys.stdin).get('planId',''))")
[ -n "$PLAN" ] || { echo "[eval] no planId in: $RESP"; exit 1; }
echo "$PLAN" > "$DIR/plan.id"
echo "[eval] plan $PLAN"
date -u +"plan create %H:%M:%S" > "$DIR/timing"

# Approve once the planner has produced tasks (status awaiting_approval).
START=$(date +%s)
APPROVED=0
while :; do
  S=$(curl -s --max-time 10 "$API/plans/$PLAN" | python3 -c "import json,sys;print((json.load(sys.stdin).get('plan') or {}).get('status',''))" 2>/dev/null || echo '')
  NOW=$(date +%s)
  if [ "$APPROVED" = 0 ] && [ "$S" = "awaiting_approval" ]; then
    curl -s -X POST "$API/plans/$PLAN/approve" >/dev/null && APPROVED=1
    echo "[eval] approved"; date -u +"approved %H:%M:%S" >> "$DIR/timing"
  fi
  case "$S" in
    completed|failed) echo "[eval] plan $S"; break ;;
    paused) echo "[eval] plan paused (a decision is waiting, or the budget cap hit)"; break ;;
  esac
  if [ $((NOW - START)) -ge "$TIMEOUT" ]; then echo "[eval] timed out after ${TIMEOUT}s (status=$S)"; break; fi
  sleep 10
done
date -u +"plan end %H:%M:%S" >> "$DIR/timing"

echo "[eval] ---- tally ----"
python3 "$HERE/tally.py" || true
echo "[eval] ---- timing ----"; cat "$DIR/timing"
echo "[eval] decisions log: $DIR/decisions.log ; ws log: $DIR/ws.log"
echo "[eval] run \`node --test\` in $PROJECT to check the work passed."
