# Solix Pro licensing

Solix Pro is gated by an **offline, signature-verified license** — no license
server, no phone-home (the product's 100%-local promise). This repo does
**verification only**; the private signing key lives in your KMS/HSM and issues
keys in a private pipeline that is deliberately **not** part of this MIT codebase.

Consequence of offline verification: a delivered key **cannot be remotely
revoked**. That's acceptable for a $49–79 developer tool (and is why the product
sold is perpetual — see below).

## Status: dormant (free public beta)

Enforcement is **off by default** — everyone is Pro during the beta. Turn it on
only when you're ready to sell:

- Set `SOLIX_PRO_ENFORCE=1` (or bake the default `true` in the release), and
- Embed the real public key in `PUBLIC_KEY_PEM` (`packages/server/src/licensing.ts`).

Until both are done, `getEntitlement()` returns `pro` with reason `beta`.

## What we sell (decided): perpetual + optional updates subscription

The TablePlus model:

- **Solix Pro (one-time, perpetual)** — never expires; unlocks Pro forever on the
  builds it covers. `kind: 'perpetual'`, no `expiresAt`, `updatesUntil = purchase + 1yr`.
- **Solix Updates (optional annual subscription)** — extends the covered-updates
  window. On each renewal, re-issue the buyer's license with `updatesUntil` pushed
  out another year.

Pricing: **$49 founder → $79** perpetual; Updates renewal ~$39/yr (optional).

## Key format

```
base64url(JSON payload) + "." + base64url(Ed25519 signature over the payload bytes)
```

Verified by `verifyLicenseKey` (`packages/server/src/licensing.ts`): the payload
is returned only after the signature checks out and `product === 'solix' &&
edition === 'pro'`. If your KMS lacks Ed25519 (e.g. AWS KMS), issue **ECDSA
P-256** instead — the verifier's `crypto.verify` call handles both; just embed the
matching public key.

### Payload schema (`License`)

| field          | notes |
| -------------- | ----- |
| `licenseId`    | unique id (uuid) |
| `product`      | `"solix"` |
| `edition`      | `"pro"` |
| `kind`         | `"perpetual"` (default) or `"subscription"` |
| `issuedAt`     | epoch ms |
| `updatesUntil` | epoch ms — covers releases up to this date (perpetual + 1yr) |
| `expiresAt`    | epoch ms — **enforced** (subscriptions only); perpetual omits it |
| `orderId`      | Paddle transaction/subscription id (support/audit) |
| `purchaser`    | `{ email?, name? }` |
| `meta`         | free-form |

`resolveEntitlement` returns Community if `expiresAt` is set and in the past. A
perpetual license (no `expiresAt`) is Pro forever.

## Updates-window enforcement — DEFERRED

`updatesUntil` is stored but **not yet enforced**: today a perpetual key unlocks
every build. To make the Updates subscription meaningful later, bake a build
timestamp (`__SOLIX_BUILD_TS__`, alongside `__SOLIX_VERSION__` in the CLI tsup
`define`) and treat a license as "updates-lapsed" when `buildTs > updatesUntil` —
still Pro on the installed build, but newer releases prompt a renewal. Ship
"perpetual works on everything" first; enable this when there's a version worth
gating.

## Issuing keys (out of this repo — your private pipeline)

**Never put the private key in this repo or in the published npm package.** Only
the public key ships.

1. **Two Paddle products/prices:** *Solix Pro* (one-time) and *Solix Updates*
   (recurring annual).
2. **Webhook receiver** (serverless; uses a KMS signing grant, never the raw key):
   - `transaction.completed` for *Solix Pro* → sign a perpetual license
     (`kind:'perpetual'`, `updatesUntil = now + 1yr`, `orderId = ptxn_…`,
     `purchaser.email`) → email the key.
   - `transaction.completed` / `subscription.activated` / `subscription.updated`
     for *Solix Updates* → look up the buyer's license, re-sign with `updatesUntil`
     extended one year → email the refreshed key.
   - Verify Paddle's webhook signature before signing anything.
3. **Dev/manual issuance:** `node packages/cli/scripts/license-keygen.mjs` —
   `keygen` makes a keypair + prints the public PEM to paste into `PUBLIC_KEY_PEM`;
   `sign <keyfile> [--kind subscription] [--days N] [--order id] [--email x]`
   prints a key. This is for testing and low-volume beta issuance only —
   production signing is KMS/HSM.

## Activating (built-in)

- CLI: `solix license activate <key>` (verifies + writes `~/.solix/license` at
  0600 + reloads a running server) and `solix license status`.
- UI: the Maestro panel shows a Community/Pro badge; a gated run surfaces a
  "paste license key → Activate" box.

## Go-live checklist

1. Generate the keypair in KMS; paste the **public** key into `PUBLIC_KEY_PEM`.
2. Configure the two Paddle products + the webhook receiver (KMS signer).
3. Set `SOLIX_PRO_ENFORCE=1` and cut the monetization release.
4. Announce at **$49 founder → $79**.

## Containment (related): safe-by-default

Autonomous workers are governed by the command denylist out of the box — Solix
injects a fail-closed tool-call gate into the workers it launches. Opt out with
`SOLIX_CONTAINMENT=0`. The denylist is a guardrail, not isolation; for hard
isolation set an OS sandbox via `SOLIX_SANDBOX_CMD` (e.g.
`bwrap --unshare-net --bind <cwd> <cwd>`).
