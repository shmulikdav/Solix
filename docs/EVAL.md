# Evaluating Solix

One fixed task, run three ways, measured the same way each time. This is the
harness behind the numbers in the release notes and the partner brief, kept in
the repo so anyone can reproduce them and so a release cannot quietly regress
them.

The scripts live in [`scripts/eval/`](../scripts/eval/). They need a running
Solix and a real agent (`claude`), so **this does not run in CI** — it is a
before-every-release ritual, not a unit test.

## The task

`scripts/eval/SPEC.md` is the whole task: build a small `tally` line/word/char
counter in Node, with tests, flags, `--json`, stdin, and a missing-file exit
code. It is deliberately dull and self-contained — large enough to need several
steps and a few files, small enough to finish in minutes and to judge by
`node --test`. The point is not the program; it is what each system does around
the program.

"Done" is objective: `node --test` passes, `echo "a b\nc" | node bin/tally.js`
prints the right numbers, and the work is committed.

## What is measured

Every run records the same five things:

| Metric | How |
|---|---|
| **Holds** | How many times a person had to answer the gate. Fewer is better; zero means nobody was needed, which at `standard` should never happen for risky calls. |
| **Cost** | Sum of `cost_usd` over every session the run spawned (planner, workers, verifiers, retries). `tally.py` prints it; `GET /api/plans/:id` returns `spendUsd`. |
| **Wall time** | Plan-create to plan-end, from `scripts/eval/.eval/timing`. |
| **Interventions** | Anything a person had to do that was not answering a hold — a nudge, a restart, a correction. |
| **Result** | Did `node --test` pass, and was the work committed. |

## The three ways

Run the same spec as:

1. **Plain Claude Code** — `claude -p` in the project, no Solix. The floor
   everything else is measured against.
2. **Solix / Maestro at `standard` with `solix rules defaults`** — the product
   as a team would run it: a plan decomposed into worker + verifier tasks, the
   gate holding what the rules do not cover.
3. **A comparison framework** (the review used Paperclip) — optional, for a
   third column.

## Measured so far

One run each on this spec. Single runs vary — agent cost and wall time swing
±30% between runs — so read these as the shape, not a benchmark:

| | Plain Claude Code | Solix 1.18.3 (`standard`, no rules) | Solix 1.19 (`standard` + default rules) |
|---|---|---|---|
| Holds | — (no gate) | **30** (one per tool call) | **4** |
| Decided by a rule | — | — | 27 |
| Cost | ~$1.80 | ~$5.35 | ~$5.45 |
| Wall | ~2m20s | ~9m | ~4m |
| Interventions | 0 | 0 | 0 |
| Result | pass | pass | pass |

What this says plainly:

- **The gate's cost is attention, and 1.19 is where that stopped being
  absurd.** Thirty holds for thirty tool calls — `Read SPEC.md` included — was
  the finding that blocked adoption. Default rules take that to four, and two
  of the four are a rule away.
- **Solix costs more than plain Claude Code**, because it runs a verifier after
  every worker and sometimes retries. That is the trade: a second model checks
  the work, and nothing destructive runs unseen. On this task the multiple is
  about 3×.
- **Against the targets below, 1.19 is close but not clean.** Holds landed at 4
  (target ≤3) and cost at ~$5.45 (target ≤$4). The holds gap is rule coverage;
  the cost gap is the verifier pass, which 1.20's cheaper-model routing is meant
  to narrow. Stated here rather than rounded away.

## 1.19 targets

On this spec, at `standard` with default rules: **holds ≤3, cost ≤$4, wall ≤7
min, 0 unplanned interventions, tests passing and committed.** The last run met
wall, interventions and result; it missed holds (4) and cost (~$5.45).

## Running it

```sh
solix start                        # a real claude must be on PATH
export SOLIX_EVAL_DIR=/tmp/solix-eval
scripts/eval/run.sh                # creates the project, runs the plan, tallies
```

`run.sh` sets up a fresh checkout with only the spec, installs the default
rules, starts a websocket logger and a stand-in approver (it answers the holds
the rules do not, the way a careful reviewer would — read-only and in-project
writes and benign build/test/commit yes, destructive or outbound no), creates
and approves the plan, polls to completion, and prints the tally and timing.
`scripts/eval/mon.sh` gives a live snapshot while it runs.

For the **plain Claude Code baseline**, run `claude -p` against a fresh copy of
the same project and time it by hand — there is no gate to instrument.

## The safety suites

The numbers above are about cost and friction. The guarantees are covered by
the executable claims in [`docs/CLAIMS.md`](./CLAIMS.md) and walked by hand in
[`docs/E2E-SMOKE-TEST.md`](./E2E-SMOKE-TEST.md):

- **Suite E** — the gate holds, deny prevents, approve allows, fail-closed
  under `Ctrl+C`, a denial is sticky, a restart pauses rather than deciding,
  the dial will not drop under running work.
- **Suite F** — the containment denylist refuses at every level.
- **Suite H** — the `Host` and `Origin` gates refuse a rebinding page.

Run the claim tests with `pnpm test` and `pnpm claims:check`; walk the smoke
suites against the packed tarball before a release.
