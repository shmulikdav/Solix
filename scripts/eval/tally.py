#!/usr/bin/env python3
"""Final tally for one Maestro eval run: every session the plan spawned, its
cost and role, and the plan's own spend. Reads the plan id from
$SOLIX_EVAL_DIR/plan.id.

env: SOLIX_PORT (4242), SOLIX_EVAL_DIR (./.eval)
"""
import json, os, urllib.request

PORT = os.environ.get('SOLIX_PORT', '4242')
DIR = os.environ.get('SOLIX_EVAL_DIR', os.path.join(os.getcwd(), '.eval'))
API = f'http://127.0.0.1:{PORT}/api'


def get(path):
    return json.load(urllib.request.urlopen(API + path, timeout=15))


def main():
    plan_id = open(os.path.join(DIR, 'plan.id')).read().strip()
    d = get(f'/plans/{plan_id}')
    p = d.get('plan', d)
    tasks = d.get('tasks') or []
    print('plan:', p.get('status'),
          'spendUsd=', d.get('spendUsd'),
          'budgetUsd=', p.get('budgetUsd'),
          'parallelLimit=', p.get('parallelLimit'))

    rows, seen = [], set()

    def add(label, sid):
        if not sid or sid in seen:
            return
        seen.add(sid)
        try:
            s = get(f'/sessions/{sid}')
        except Exception as e:
            s = {'error': str(e)}
        rows.append((label, sid[:8], s.get('status'), s.get('sessionRole'),
                     s.get('costUsd') or 0, s.get('contextUsagePct'), s.get('model')))

    for t in tasks:
        add(f"worker {t['id'][:4]} a{t.get('attempts')}", t.get('sessionId'))
        add(f"verifier {t['id'][:4]}", t.get('verifierSessionId'))
    for m in get('/missions'):
        add('mission', m.get('sessionId'))

    total = 0.0
    print(f"{'role':24}{'session':9}{'status':12}{'role':10}{'usd':>8}  ctx%   model")
    for r in rows:
        total += r[4]
        print(f"{r[0]:24}{r[1]:9}{str(r[2]):12}{str(r[3]):10}{r[4]:8.3f}  {r[5]}   {r[6]}")
    print(f"TOTAL sessions={len(rows)} usd={total:.3f}")

    # Holds a person was actually left with, and how many Solix decided by rule.
    decisions = os.path.join(DIR, 'decisions.log')
    if os.path.exists(decisions):
        human = sum(1 for _ in open(decisions) if ' APPROVE ' in _ or ' DENY ' in _)
        print(f"human decisions logged by the approver: {human}")
    try:
        audit = get('/audit?limit=2000')
        rule = sum(1 for e in audit
                   if e.get('kind') in ('permission_auto_approved', 'permission_auto_denied'))
        print(f"decided by a rule (auto): {rule}")
    except Exception:
        pass


if __name__ == '__main__':
    main()
