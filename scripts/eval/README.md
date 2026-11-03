# scripts/eval

The release-time evaluation harness. One fixed task (`SPEC.md`), run against a
live Solix + a real `claude`, measured for holds, cost, wall time,
interventions and result. **Not a CI test** — it launches a real agent.

See [`docs/EVAL.md`](../../docs/EVAL.md) for the method, the three-way
comparison, the measured numbers and the per-release targets.

| File | What it is |
|---|---|
| `SPEC.md` | The fixed task: a small `tally` CLI with tests. |
| `run.sh` | One run end to end: set up the project, create + approve the plan, poll, tally. |
| `wslog.mjs` | Logs every websocket event, so holds can be answered and counted. |
| `approver.py` | Answers the holds the rules do not reach, the way a careful reviewer would. |
| `mon.sh` | A live snapshot of a run in progress. |
| `tally.py` | Final cost / session / rule-decision tally for a finished run. |

All read `SOLIX_PORT` (4242), `SOLIX_EVAL_DIR` (where results live), and
`SOLIX_PROJECT` (the checkout the agent writes in). `run.sh` takes a few more —
see the top of the file.
