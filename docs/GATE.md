# `solix gate` — the gate with nobody at it

> Available from `@shmulikdav/solix` **1.20.0**. On an older install,
> `solix gate` is not a command (1.18.x answers `error: unknown option '--rules'`);
> `npm i -g @shmulikdav/solix` updates it.

Run an agent in CI, or anywhere unattended, under the same approval rules your
team uses at the desk.

```sh
solix gate --rules policy.json -- claude -p "Fix the failing test in src/count.js"
```

- A call a **rule allows** proceeds.
- A call **no rule covers** is **refused at once** — fail closed. The agent is
  told nobody is at the gate and to report what it needed, so a person can add
  a rule. Nothing waits for an answer that is not coming.
- The **containment denylist** (`rm -rf`, `curl | sh`, writes to `/etc`, …) runs
  first, as it always does. No rule overrides it.
- Afterwards, the record of the run is written out (see *Artifact*).

The attended gate does the opposite with an uncovered call: it **holds** it for
a person. In CI that would only stall each call until the 300-second timeout
denied it anyway.

## Policy file

A JSON array of rules, the same shape `solix rules add` and `POST /api/rules`
take. Every rule in a gate policy is global to the run.

```json
[
  { "match": "readonly_tool" },
  { "match": "write_inside_root" },
  { "tool": "Bash", "match": "command_prefix", "value": "npm test" },
  { "tool": "Bash", "match": "command_prefix", "value": "git diff" },
  { "tool": "Bash", "match": "command_prefix", "value": "git push", "decision": "deny" }
]
```

`--rules defaults` uses Solix's opt-in default set (`solix rules defaults`).
A malformed policy stops the gate **before** the agent runs.

Most policies should **start from the defaults** and add what the job needs.
A policy written from scratch has to list every read-only command an agent
might pipe through (`head`, `tail`, `wc`, …), and a missing one refuses the
whole command:

```json
{
  "extends": "defaults",
  "rules": [
    { "tool": "Bash", "match": "command_regex", "value": "^npm (pack|publish) --dry-run$" },
    { "tool": "Bash", "match": "command_prefix", "value": "git commit", "decision": "deny" }
  ]
}
```

A deny rule wins over an allow rule wherever it comes from, so a policy can
extend the defaults and still refuse something they allow (here, committing).

### Check a policy before an agent runs under it

```sh
solix rules test --rules .solix/policy.json "npm publish --dry-run 2>&1 | tail -80"
```

```
    ✓ npm publish --dry-run 2>&1  allow shell commands matching /^npm (pack|publish) --dry-run$/
    ✓ tail -80                    allow shell commands starting with `tail`

  ALLOWED by rule. Under `solix gate` it runs; at the desk nobody is asked.
```

It prints the gate's own verdict and, when a command is not covered, which
part: *no rule covers this*, or *`cat` matches, but /etc/hostname is outside
the project*. Exit 0 when allowed, 1 when not, 2 when the policy does not load.
Without `--rules` it tests against the rules in force on this machine.

A shell command is allowed only when **every segment** of it is covered (`ls &&
git push` is not "an `ls`"), and the contents of `$( … )` are checked as their
own segments — the same matcher the desk uses. An allow rule, prefix or regex,
never covers a path outside the project, including a redirect target
(`echo x >/etc/y`). Redirects that only move or discard output (`2>&1`,
`>/dev/null`) are ignored when matching, so `^npm test$` covers
`npm test 2>&1`.

## Artifact

Written to `--out` (default `./solix-gate/`):

| File | What it is |
|---|---|
| `audit.json` | Every audit row of the run: what was allowed by rule, refused, or blocked by the denylist, with the command. |
| `report.json` | The signed fleet report for the run window — hash-chained, ed25519-signed by the machine that ran the gate. Check it with `solix report --verify solix-gate/report.json`. |
| `report.md` | The same report, readable. |

The summary is also printed: allowed by rule, refused, blocked, and each
refused command.

**What the signature proves:** that the report was produced by the holder of
this machine's key and has not been edited since. It does not prove the agent
did nothing outside the hooks Claude Code fires — the gate sees what the agent
asks to do through its tools.

## Exit codes

| Code | Meaning |
|---|---|
| the agent's | The agent itself failed. |
| `3` | The agent succeeded but **at least one call was refused**. A step that refused something and still went green would be lying. Pass `--allow-denials` to accept refusals and return the agent's code. |
| `2` | The policy was rejected, or the gate could not start. Nothing was run. |
| `0` | Everything the agent asked for was allowed by the policy. |

## GitHub Actions

```yaml
- name: Agent under policy
  run: |
    npm i -g @shmulikdav/solix
    solix gate --rules .solix/policy.json --out solix-gate -- \
      claude -p "Fix the failing test and commit the fix"
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}

- name: Keep the record
  if: always()
  uses: actions/upload-artifact@v4
  with:
    name: solix-gate
    path: solix-gate/
```

## How it works

`solix gate` starts a private Solix server on a fresh temp `SOLIX_HOME` and a
free port, in **headless** mode (`solix start --headless`): only the token and
hook scripts are installed there, and `~/.claude` is never touched. It loads the
policy, then runs your command with the hooks handed to Claude Code for that one
run via `--settings` (for another runtime, the settings file's path is in
`SOLIX_GATE_SETTINGS`). The hooks run fail-closed (`SOLIX_GATE_POLICY=deny`), so
if the gate is unreachable a call is refused, not waved through. When the agent
exits, the server is stopped and the artifact is read from its database.

The guarantee is `CLAIM-HEADLESS-FAILS-CLOSED` in [`CLAIMS.md`](./CLAIMS.md).
