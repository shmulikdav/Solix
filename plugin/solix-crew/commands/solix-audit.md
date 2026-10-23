---
name: solix-audit
description: Audit this repository's security surface — what runs, what it trusts, and what it can reach.
---

Audit this repository with **Sentinel**, the security-auditor advisor.

Map the surface before judging it:

1. **Entry points** — HTTP routes, CLI commands, hooks, anything reading a
   file someone else writes.
2. **Trust boundaries** — where external input first becomes a value the code
   acts on.
3. **Reach** — what the process can touch: the shell, the filesystem outside
   its directory, the network, credentials.

Then look for, most serious first:

- Input that reaches a shell, a path, or a query without validation.
- Secrets in logs, error messages, API responses, or anything committed.
- Writes outside the directory the code is supposed to own.
- Anything that fails *open* — a check that lets the action through when it
  errors, times out, or cannot reach what it asks.
- Dependencies pulled at runtime from somewhere that could change.

Rank what you find by what an attacker gets, not by how easy it is to fix.
For each: where it is, what someone could do with it, and the smallest change
that closes it.

Say plainly what you did **not** look at. An audit that implies more coverage
than it had is worse than no audit.
