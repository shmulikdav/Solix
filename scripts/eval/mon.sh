#!/bin/sh
# One snapshot of a Maestro eval run in progress: plan status, every task, the
# live sessions, how many holds have been seen, and the project checkout.
#
# env: SOLIX_PORT (4242), SOLIX_EVAL_DIR (./.eval), SOLIX_PROJECT
PORT="${SOLIX_PORT:-4242}"
DIR="${SOLIX_EVAL_DIR:-$PWD/.eval}"
PROJECT="${SOLIX_PROJECT:-$DIR/project}"
API="http://127.0.0.1:${PORT}/api"
P=$(cat "$DIR/plan.id" 2>/dev/null)
echo "### $(date -u +%H:%M:%S)  plan=$P"
curl -s --max-time 10 "$API/plans/$P" | python3 -I -c "
import json,sys
d=json.load(sys.stdin); p=d.get('plan',d)
print(f\"-- plan {str(p.get('id',''))[:8]} status={p.get('status')} spend={d.get('spendUsd')} budget={p.get('budgetUsd')}\")
for t in d.get('tasks') or []:
    print(f\"  {str(t.get('id',''))[:8]} {str(t.get('status')):12} attempts={t.get('attempts')} | {str(t.get('title'))[:56]}\")" 2>/dev/null
echo "-- holds seen --"
grep -c PERMISSION_REQUEST "$DIR/ws.log" 2>/dev/null | sed "s/^/  /"
echo "-- checkout --"
cd "$PROJECT" 2>/dev/null && git log --oneline 2>/dev/null | head -3 && git status --short 2>/dev/null | head -4
