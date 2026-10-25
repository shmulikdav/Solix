# Solix — launch readiness

**Assessed:** 2026-10-25 against `1.13.0` (published to npm) and
`www.solixsys.com` (live).

**Verdict:** the product is built and shipped. What is missing is almost
entirely *proof* and *distribution*, not code. One item is a genuine
stop-ship.

---

## 1 · What is already done

Each line here was checked, not assumed. The file reference is where to look
if you want to re-verify it.

### The product

| | Evidence |
|---|---|
| Published to npm, installable | `@shmulikdav/solix@1.13.0`, `dist-tags.latest = 1.13.0`, tarball 60 files |
| Install is one step | `npm i -g` then `solix` wires hooks itself — no separate `solix install` |
| Install is reversible | backs up to `~/.claude/settings.solix.backup.json`; `solix uninstall` restores it |
| The blocking gate | `hooks/pre-tool-bash.sh` → `POST /events/permission` → held until answered |
| Fail-closed | launcher injects `SOLIX_GATE_POLICY=deny`; an unreachable gate denies |
| Containment floor | `containment.ts` — `rm -rf /`, fork bombs, `mkfs`, `dd of=/dev/`, `curl\|sh`, `sudo`, SSH key writes. Not on the governance dial |
| Governance dial | `observe` / `standard` / `strict` via `solix level` |
| Budget control | Maestro warns ~80% and pauses *before* exceeding (`orchestrator/index.ts:357`) |
| Worktrees | opt-in per task, keyed by branch (`launcher.ts:674`) |
| Three views + Decisions rail + ⌘K | `V` cycles Galaxy / List / Missions |
| The band | `plugin/solix-band` — Approve/Deny above the Claude Code prompt, all four surfaces |
| The crew | `plugin/solix-crew` — 15 advisors as subagents, `/solix-review`, `/solix-audit` |
| New in 1.13.0 | `solix gain`, `solix ledger`, `solix import`, `solix level` |
| Demo mode | `solix demo` — 8 projects, ~30 sessions, ~10s, fully synthetic |

### The privacy claim — verified

The README says **"No account, no telemetry"** and **"100% local"**. This is
the kind of claim that ends a launch badly if it is wrong, so it was checked
directly: the shipped CLI bundle contains exactly **one** external host,
`api.telegram.org`, and it is an opt-in notifier that returns `null` unless
*you* supply a bot token and chat ID (`state/notifiers.ts:198`). There is no
phone-home, no analytics SDK, no crash reporter.

**The claim holds.** It is also the strongest thing you have, and the site
currently under-uses it.

### Around the product

| | State |
|---|---|
| Repo | public, MIT, TypeScript |
| Tests | 487 unit + 12 plugin + 3 plugin validations + clean-machine rehearsal |
| Bug intake | `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.yml` |
| Security policy | `.github/SECURITY.md` |
| QA | `docs/E2E-SMOKE-TEST.md` — 16 suites, ~70 cases, P0/P1/P2 |
| Website | live on `www.solixsys.com`, apex 301s to www, canonical pinned, real 1.12.0 screenshots, OG image |
| Changelog | `CHANGELOG.md` current through 1.13.0 |

---

## 2 · Blockers — do not launch until these pass

### B1 · Suite E has never been run · **STOP-SHIP**

The gate has unit tests at every layer and a live test of the hook
(`gate.live.test.ts`). What has **never** been exercised is the last hop:
whether Claude Code actually honours the deny decision Solix hands back.

Every claim on the website and the README rests on this one link.

- [ ] **E2** — a sensitive command is *held*, agent stalls, card shows the exact command
- [ ] **E3** — **Deny, then `ls ~/solix-qa/canary/` — `keep.txt` must survive**
- [ ] **E4** — Approve lets it through
- [ ] **E5** — `Y`/`N` do nothing while the Decisions panel is closed
- [ ] **E6** — kill Solix mid-decision; the agent is told `gate unavailable (fail-closed)` and denied

If E3 fails, the gate is auditing after the fact rather than blocking, and
1.13.0 must be pulled inside npm's 72-hour unpublish window.

### B2 · Suite F — containment against a real agent

- [ ] `rm -rf /` and friends are refused by the denylist, not merely logged

~10 minutes for both suites. This is the entire blocker list.

---

## 3 · Launch day — small, concrete, all fixable in an hour

### L1 · The GitHub repo description is wrong

> *"Agnet Orchestration Space"*

A typo (`Agnet`), on a public repo, as the first line a visitor reads — and
it does not match the positioning everywhere else ("the control layer for your
coding agents"). Fix to match the README.

- [ ] Repo description + topics (`claude-code`, `ai-agents`, `developer-tools`, `local-first`)
- [ ] Turn on **Discussions** — currently off, so there is nowhere to ask a
      question that is not a bug report

### L2 · The Releases page says 1.9.1

The only published GitHub Release is **v1.9.1 (2 Sept)**. Tags exist for
everything since, but with no notes — so the Releases page shows a seven-week-old
version as newest while npm serves 1.13.0. To anyone checking whether this is
maintained, that reads as abandoned.

- [ ] Publish a release for `v1.13.0` from the CHANGELOG entry
- [ ] Optionally backfill 1.12.0 / 1.12.1

### L3 · The website does not know 1.13.0 exists

The site is accurate for 1.12.0. Everything in 1.13.0 is absent:

- [ ] **The plugin install path** — `/plugin marketplace add shmulikdav/Solix`
      is a genuinely new front door (the crew works with *no Solix server at
      all*) and appears nowhere on the site
- [ ] **The band** — the answer to "why do I have to look at a browser tab"
- [ ] `solix gain` — the single best demo of the product's value
- [ ] `solix ledger`, `solix level`, `solix import`
- [ ] `softwareVersion` in the schema.org block
- [ ] Lead with **"no account, no telemetry, nothing leaves your machine"** —
      it is verified, it is rare, and it is currently buried

### L4 · Nobody has been invited

1 star, 0 forks, 0 open issues. No testers, no posts.

- [ ] Send `docs/E2E-SMOKE-TEST.md` to 5–10 testers as the bug-report format
- [ ] Wait for their results before any public post

---

## 4 · Decisions only you can make

These are not work items. They are forks in the road, and both are cheaper to
settle before launch than after.

### D1 · Is Solix free, or is Pro coming?

The code contains a complete Pro licensing system — Ed25519 keys, offline
verification, tier gating at seven call sites in the orchestrator, a
`FREE_TASK_LIMIT` of 3 tasks per plan. It is **dormant two ways over**:

```ts
const PUBLIC_KEY_PEM: string | null = null;   // licensing.ts:29
```

No key is baked in, so nothing can verify a license even if you flipped
`SOLIX_PRO_ENFORCE=1`. Everyone is Pro, reason `"beta"`.

Meanwhile the site says **"Free & MIT"** with `price: "0"` in its structured
data. That is coherent today. But note the tension: **under MIT, anyone can
delete the tier check and redistribute.** A paid tier on an MIT core is a
positioning choice, not a technical one — and changing the licence after
people adopt it is far harder than choosing now.

- [ ] Decide: free-forever MIT, or MIT core + a differently-licensed Pro
- [ ] If Pro: the key must be generated and embedded *before* any paid promise

### D2 · Which platforms do you support?

`engines: node >= 20`. There are `win32` branches in `doctor.ts`, `demo.ts`
and `install.ts`, but Windows has never been tested, and the smoke test offers
a WSL checkbox without a native Windows one.

- [ ] Either test on Windows, or state **macOS / Linux / WSL** plainly on the
      site and in the README

---

## 5 · After launch

Known, documented, not blocking:

- Routines are not org-scoped; there is no `PATCH /api/schedules/:id`
- Three dead website components (`MissionControlMockup`, `SolarSystem`, `StaticHeroScene`)
- Website `bun run lint` fails repo-wide on pre-existing prettier errors
- Codex / other-runtime support (`docs/multi-runtime.md`)
- Whether subscribers should see token counts rather than list-price dollars —
  `solix import` reports list price, which overstates what a Max subscriber
  actually pays

---

## The short version

You are **one 10-minute test** away from being able to launch honestly, and
about **an hour of copy and repo housekeeping** away from launching well.

The sequence: Suite E and F → fix the repo description and publish the release
→ update the site for 1.13.0 → invite testers → post.
