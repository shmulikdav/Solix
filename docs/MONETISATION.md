# Solix — how this makes money

**Written:** 2026-10-25, against `1.13.0`. A decision record, not a plan of
record — revisit it when the facts below change.

---

## The one idea

**The thing an individual developer will never pay for — something watching
what their agents do — is exactly what an organisation will pay for. And an
organisation is entitled to watch its own fleet.**

Same capability. Opposite polarity depending on who is asking. That is where
the money is, and it is not where the current gate is.

---

## Three facts that constrain every option

### 1 · MIT plus an in-code gate is not weak enforcement. It is none.

Seven call sites in `orchestrator/index.ts` consult `getEntitlement()`. One
edit to `licensing.ts` returns `{ tier: 'pro' }` and every one of them opens.
The code is careful — it re-gates on resume, and delegation cannot bypass the
task cap — but careful enforcement of a rule anyone may legally delete is
still no enforcement.

This is not an argument against MIT. It is an argument against putting the
paid thing *inside* the MIT code.

### 2 · Zero telemetry means you cannot meter.

Solix cannot count installs, seats or usage, by design — and that design is
the product's best marketing. So per-seat or per-usage billing has nothing to
bill against. Offline Ed25519 licensing is the correct answer to that
constraint, but it reduces to an honour system, and honour systems work on
companies (which buy compliance and indemnity) and never on individuals.

### 3 · The current gate throttles the wrong person.

```ts
export const FREE_TASK_LIMIT = 3;   // licensing.ts
```

Free users get plans of up to three tasks, and no full-auto. So the developer
running a twenty-task Maestro plan — the one who would tell people about it,
record a demo, bring it to work — is the one who hits the wall. You have
gated your best advocate and your best demo, and the price of getting past it
is deleting a line of TypeScript.

---

## The licence is not the lever

The instinct is "MIT is the problem, relicense." It isn't. The lever is
**what the paid artifact is**:

| If the paid thing is… | Then the licence… |
|---|---|
| a flag inside the open code | cannot save you — nothing short of proprietary does |
| a separate product you never published | does not matter — MIT on the core costs you nothing |

**Recommendation: keep MIT.** Adoption is the actual bottleneck — one star —
and MIT is the adoption engine. AGPL or BUSL would trade your only growth
asset to protect revenue that does not exist yet, and enterprise legal teams
routinely block AGPL for locally-installed tooling, which is precisely the
buyer you eventually want.

---

## Ranked: how this earns

### 1 · Solix Teams — a self-hosted aggregation server · **the business**

Local Solix stays free, MIT and unchanged. Teams is a **separate server the
company runs**, which local instances report to.

- Fleet-wide spend across every developer, not just your own machine
- Policy set centrally: governance level, budget caps, additions to the
  denylist — so a developer cannot quietly dial themselves to `observe`
- Every ledger aggregated into one audit trail

It never ships as open source, so there is nothing to strip out. It extends
`orgs`, which already exists. And it does not break the local promise: the
developer's **code and prompts still never leave their machine** — only
governance metadata, and only to their own employer's server. Say that
plainly and it survives contact with a privacy-minded buyer.

**Price: ~$25/developer/month.** The ROI argument writes itself — Claude runs
$200–800 per developer per month, and `solix gain` already computes what was
prevented. **`solix gain` is the renewal conversation.**

*Cost: months. This is a real product — auth, multi-tenancy, RBAC.*

### 2 · The compliance pack · **ship this first**

`gain` and `ledger` are already evidence generators. Make the audit log
**signed and tamper-evident**, add SIEM export, and you can answer the
question an auditor actually asks: *prove no agent ran an unreviewed
destructive command last quarter.*

Much smaller than Teams, sellable sooner, and it plays to the strength you
already have rather than a new one.

### 3 · Design-partner contracts · **do this before either of the above**

Three to five companies running Claude Code at scale, paying for help setting
up agent governance. Fastest real revenue, funds the build, and — the actual
point — **tells you what Teams should be instead of you guessing.**

For a solo founder before product-market fit this is the highest
expected-value move on the page, by a distance.

### 4 · GitHub Sponsors

Ten minutes, will not pay rent, signals that the project is maintained.

### 5 · An individual Pro tier · **don't**

Unenforceable under MIT, unmeasurable without telemetry, and aimed at the
buyer least likely to pay. This is what is currently built.

---

## What to do with the dormant code

Right now it is a **liability**, not an asset in waiting:

- `PUBLIC_KEY_PEM = null`, so no key can ever verify — the feature cannot work
- `solix license status` already admits *"licensing is not enabled in this
  build"*
- Anyone reading the source finds a tool that intends to charge them for
  plans longer than three tasks. That is a worse first impression than no
  paid tier at all

**Removed in full** (commit `93b1768`'s parent is the last one that has it):
`licensing.ts`, `evaluateRunGate`, `FREE_TASK_LIMIT`, the seven orchestrator
call sites, the `solix license` command, `/api/system/entitlement`,
`/api/license/activate`, the entitlement badge and the paste-a-key box, and
`docs/licensing.md` with its Paddle plan.

> **Changed from the first draft of this document.** It said to keep
> `verifyLicenseKey` for Teams seat licensing later. On doing the work that
> was wrong: with every caller gone it becomes the only module in the
> codebase with no production use, which rots and invites the assumption that
> it is wired up. Git has it — `git show <sha>:packages/server/src/licensing.ts`
> — and Teams will want a different payload anyway (seats and an org, not a
> per-plan tier), so it would be rewritten rather than reused.

Then say "free, MIT, all of it" and mean it.

**What did not change, and must not:** full-auto is still refused unless
worker containment is intact. That was never a commercial gate. And full-auto
only skips the *plan* approval — every risky command its workers run is still
held by the gate, which `autoMode` never reaches.

---

## Why the timing argument is real, but about something else

Relicensing gets harder as contributors accumulate — true, and the usual
reason to decide early. But that is not the binding constraint here.

**The binding constraint is users.** If people adopt Solix on the promise of
free full-auto and unlimited plans, and you gate those later, that is a
betrayal and it will be remembered. Today, at one star, you can shape this
any way you like at zero cost. That window closes the moment the launch
works, not the moment a contributor appears.

---

## This month

1. **Rip the tier gates out.** Ship "free, MIT, all of it" with conviction. *(~1 hour)*
2. **GitHub Sponsors on.** *(10 minutes)*
3. **Suite E, then distribution.** Nothing else matters until people use it.
4. **Talk to ten teams running Claude Code.** One question: *"how do you know
   what your agents spent, and what they were allowed to do?"* Their answer is
   the Teams specification.
5. **A paying design partner before a line of Teams is written.**

---

## The honest risk

Everything that makes Solix lovable — no account, nothing leaves your
machine, free and MIT — is in tension with everything that makes software
profitable. **You will not get rich on individual developers.** The business,
if there is one, is selling an organisation visibility into its own fleet.

Decide whether that is a business you want to run. If it is not, Solix is an
excellent portfolio piece and calling card, and that is a legitimate answer —
but it is a different answer, and it should be chosen rather than arrived at.
