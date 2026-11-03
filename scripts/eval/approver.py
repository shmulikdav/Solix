#!/usr/bin/env python3
"""Answer Solix holds the way a careful person at the gate would — instantly,
and log every decision, so a run can be measured without a human sitting there.

Approves read-only tools, writes inside the project, and benign build/test/
commit shell. Refuses anything destructive or outbound. This stands in for the
reviewer at the gate; with `solix rules defaults` installed, most calls are
auto-decided by Solix and never reach this at all — which is the number the
eval is measuring (how many holds a person is actually left with).

env: SOLIX_PORT (4242), SOLIX_EVAL_DIR (./.eval), SOLIX_PROJECT (the checkout
the agent writes in — writes outside it are refused).
"""
import json, os, re, time, urllib.request

PORT = os.environ.get('SOLIX_PORT', '4242')
DIR = os.environ.get('SOLIX_EVAL_DIR', os.path.join(os.getcwd(), '.eval'))
PROJECT = os.path.realpath(os.environ.get('SOLIX_PROJECT', os.path.join(DIR, 'project')))
API = f'http://127.0.0.1:{PORT}/api'
WS = os.path.join(DIR, 'ws.log')
OUT = os.path.join(DIR, 'decisions.log')

DENY = re.compile(
    r'rm\s+-rf|rm\s+-r\b|git\s+push|git\s+reset\s+--hard|git\s+clean|sudo|'
    r'curl\s|wget\s|chmod\s+-R\s+777|>\s*/dev/sd|dd\s+if=|:\(\)\s*\{',
    re.I,
)


def decide(tool, args):
    if tool in ('Read', 'Glob', 'Grep'):
        return True, 'read-only tool'
    if tool in ('Write', 'Edit', 'MultiEdit'):
        p = os.path.realpath(str(args.get('file_path', '')))
        inside = p.startswith(PROJECT + os.sep)
        return inside, 'write inside project' if inside else 'write outside project'
    if tool == 'Bash':
        c = str(args.get('command', ''))
        if DENY.search(c):
            return False, 'matches destructive/outbound pattern'
        return True, 'benign shell'
    if tool == 'Task':
        return True, 'subagent'
    return False, 'unknown tool'


def main():
    seen = set()
    while True:
        try:
            for line in open(WS):
                if 'PERMISSION_REQUEST {' not in line:
                    continue
                ts, _, rest = line.partition(' PERMISSION_REQUEST ')
                try:
                    d = json.loads(rest)
                except Exception:
                    continue
                rid = d.get('requestId')
                if not rid or rid in seen:
                    continue
                seen.add(rid)
                tool = d.get('tool')
                args = d.get('args') or {}
                ok, why = decide(tool, args)
                req = urllib.request.Request(
                    f"{API}/sessions/{d['sessionId']}/permission",
                    data=json.dumps({'requestId': rid, 'approved': ok}).encode(),
                    headers={'Content-Type': 'application/json'},
                    method='POST',
                )
                try:
                    code = urllib.request.urlopen(req, timeout=10).status
                except Exception as e:
                    code = f'ERR {e}'
                with open(OUT, 'a') as f:
                    f.write(f"{time.strftime('%H:%M:%S')} {'APPROVE' if ok else 'DENY'} "
                            f"{tool} {json.dumps(args)[:140]} | {why} | http={code}\n")
        except FileNotFoundError:
            pass
        except Exception as e:
            with open(OUT, 'a') as f:
                f.write(f"{time.strftime('%H:%M:%S')} LOOP-ERROR {e}\n")
        time.sleep(1)


if __name__ == '__main__':
    main()
