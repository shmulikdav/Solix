# `solix gate` — the gate with nobody at it

> **Unreleased.** `solix gate` is on `main` and ships in the next release. On
> `@shmulikdav/solix` 1.18.3 from npm it is not a command (that version answers
> `error: unknown option '--rules'`). To try it now, build from `main` and run
> the built CLI directly, which leaves your installed `solix` alone:
>
> ```sh
> git checkout main && git pull
> pnpm install && pnpm -r build
> node packages/cli/dist/index.js gate --rules defaults -- \
>   claude -p "list the files here, then try to npm publish"
> ```
>
> You should see the listing allowed, the publish refused, exit 3, and a
> `solix-gate/` folder.

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

A shell command is allowed only when **every segment** of it is covered (`ls &&
git push` is not "an `ls`"), absolute paths outside the project are never
covered, and the contents of `$( … )` are checked as their own segments — the
same matcher the desk uses.

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
