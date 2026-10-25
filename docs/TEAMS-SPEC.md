# Solix Teams — specification

**Status:** design, 2026-10-25. Decided in `docs/MONETISATION.md`.

> **Solix is free and MIT, forever, with no limits.** Teams is a separate
> server a company runs for its own fleet. Nothing in this document adds a
> gate to the open product, and nothing in it ever will.

---

## The product in one line

**Teams tells an organisation what its agents spent and what they were allowed
to do — across every developer, not one laptop.**

---

## The privacy boundary — decide this first

Solix's headline is *no account, no telemetry, nothing leaves your machine*.
Teams sends something somewhere. If that line is drawn carelessly the product
loses the only thing that makes it distinctive, so it is drawn here and
stated on the tin:

> ### Teams sees what you approved, not what you built.

| Crosses the wire | Never crosses the wire |
|---|---|
| Decision records: tool, command text, allow/deny, who decided, when | Prompts |
| Containment blocks: which rule fired, the command | Model output / completions |
| Spend: tokens, model, cost, session, project | File contents |
| Budget pauses and the spend held at each | Diffs and patches |
| Governance level in force | Source code of any kind |
| Session lifecycle: started, idle, terminated | Repository contents |

Three rules that are not negotiable:

1. **Opt-in, per machine, explicit.** No reporting endpoint configured means
   no network call, ever. This is the default and `solix doctor` says so.
2. **Self-hosted by default.** The endpoint is the company's own server. We
   never run it, never see it, never hold the data.
3. **Visible.** `solix report --preview` prints exactly what would be sent,
   as it would be sent, before anything is.

A `--redact` mode replaces command text with a stable fingerprint, for
organisations that consider a shell line sensitive. It is weaker evidence,
which is the trade-off, and the report says which mode produced it.

---

## Architecture

```
developer laptop                           the company's server
┌───────────────────────┐                  ┌────────────────────────┐
│ solix (free, MIT)     │                  │ Solix Teams            │
│                       │  ── records ──▶  │  (proprietary)         │
│  audit_events ──┐     │   append-only,   │                        │
│  sessions ──────┼──▶  │   idempotent,    │  fleet spend           │
│                 │     │   queued offline │  aggregated ledger     │
│  reporting      │     │                  │  policy source         │
│  client (MIT)   │  ◀── policy (signed) ──│  seat licence          │
└───────────────────────┘                  └────────────────────────┘
```

**The local client is MIT and lives in this repo.** Anyone can read exactly
what it sends — which is the point; a reporting client you cannot audit would
contradict the whole product. **The server is proprietary and is never
published**, so there is nothing to strip out. That is the structural answer
to the problem that sank the Pro tier.

### Upward: records

`audit_events` is already the right shape — `id, ts, kind, session_id,
advisor_id, project_id, summary, payload_json` — so the wire format is that
row plus a device identity, batched.

- **Append-only and idempotent**, keyed on the event id. A replayed batch is
  a no-op, so retries are free and ordering does not matter.
- **Queued locally.** Unreachable server means records accumulate on disk and
  go later. **Reporting never blocks an agent**, never delays a decision, and
  never fails a run. A governance tool that stalls the work gets uninstalled.
- Batched on an interval, not per event.

### Downward: policy, as a floor

The server publishes a signed policy document. The local Solix applies it as
a **floor, never an override**:

| Policy says | Developer may set | Developer may not set |
|---|---|---|
| level ≥ `standard` | `standard`, `strict` | `observe` |
| denylist + these rules | add more | remove any |
| budget cap ≤ $50/plan | anything lower | anything higher |

A developer can always be **stricter** than their organisation requires and
never looser. This matters: it keeps Solix a tool that works *for* the
developer even while it reports to their employer, and it makes the policy
mechanism impossible to resent. There is no remote kill switch, no remote
command execution, and no way for the server to make a laptop less safe.

---

## Pricing

| | | |
|---|---|---|
| **Solix** | **Free, MIT** | Everything. Unlimited plans, full-auto, every advisor. Forever. |
| **Solix Teams** | **$25 / developer / month**, billed annually (\$30 monthly). Minimum 5 seats. | Self-hosted server, fleet spend, aggregated ledger, central policy, seat licence. |
| **Solix Enterprise** | Custom | SSO/SAML, SIEM export, signed audit attestations, support SLA, deployment help. |

### Why $25 holds up

A developer running Claude Code costs the company **$200–800/month**. Twenty
developers is **$8,000/month of agent spend**, and Teams at 20 seats is
**$500** — about **6%** of the spend it governs. FinOps tooling conventionally
lands at 1–5% of managed spend, so this is in band for a product that also
carries the audit story.

And the renewal argument computes itself: **`solix gain` already reports what
was prevented** — commands the denylist refused, plans paused before crossing
their cap, and the spend held at each pause. Teams aggregates that across the
fleet. The invoice justification is a number the product generates, not a
claim a salesperson makes.

### Seat enforcement

The server is proprietary, so an offline signed seat licence (Ed25519,
exactly the mechanism removed from the CLI) works here for the reason it
could not work there: **removing it from a closed-source server you were
licensed is a breach, not a free afternoon with a text editor.**

---

## Build order

Each increment is useful on its own. **Increment 0 is sellable even if Teams
never ships**, which is the point of starting there.

### Increment 0 — `solix report` · the compliance pack · **MIT, this repo**
A signed, tamper-evident export of an audit window: every decision, every
containment block, every budget pause, with spend. Markdown, CSV and JSON.
No server, no network.

Answers the question an auditor actually asks — *prove no agent ran an
unreviewed destructive command last quarter* — and is the exact payload Teams
later aggregates, so the wire format gets designed and used before anything
depends on it.

### Increment 1 — the reporting client · **MIT, this repo** · ✅ shipped
`solix reporting {status,enable,disable,preview,push}`. Opt-in endpoint,
idempotent batched push, `preview`, `--redact`. Point it at
`file:/abs/path.jsonl` and a pilot runs with **no server at all**.

**The queue is `audit_events` itself** — append-only and ordered already, so
"pending" is everything at or after a stored high-water mark and delivery is
advancing that mark. No outbox table to fall out of sync. A failed send leaves
the cursor untouched, so records wait rather than vanish; a crash mid-send
re-sends, and the duplicate is the server's no-op. **Losing a record from an
audit trail is unacceptable; sending one twice is free.**

### Increment 2 — the server · **proprietary**
Ingest, per-developer and fleet views, seat licence. The first thing anyone
pays for.

### Increment 3 — policy as a floor · both sides
Signed policy document, applied locally as a floor.

### Increment 4 — enterprise
SSO/SAML, SIEM export, signed attestations.

---

## What is still true from `MONETISATION.md`

Design partners first. Increments 0 and 1 are deliberately the two that make
a pilot possible **without** the server existing — point them at a file, sit
with a team, and find out what the fleet view actually needs to show before
building it. The ten-teams question stands: *how do you know what your agents
spent, and what they were allowed to do?*
