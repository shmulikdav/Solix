# Solix plugins for Claude Code

Two plugins. The first is useful on its own; the second needs Solix running.

```
/plugin marketplace add shmulikdav/Solix
/plugin install solix-crew@solix
```

## solix-crew

Fifteen specialist advisors as Claude Code subagents — a code reviewer, a
security auditor, an architect, a test engineer, a FinOps analyst, a
performance engineer, and the rest. Ask for one by name, or use the two
commands:

| Command | What it does |
| --- | --- |
| `/solix-review` | Reviews the current diff the way someone who gets paged at 3am would: correctness, security, hot paths, risky logic with no test. Name a target to narrow it — `staged`, `branch`, a path. |
| `/solix-audit` | Audits the whole repository's security surface — what runs, what it trusts, what it can reach — ranked by what an attacker gets. |

No server, no account, nothing to configure. The advisors are plain subagent
definitions; read them in `solix-crew/agents/` before you install, which is
the right habit for anything that runs in your terminal.

## solix-band

```
/plugin install solix-band@solix
```

Puts Solix above your prompt: pending decisions with the command in view and
Approve / Deny beside it, or a quiet line with what the fleet is doing and
what it has cost.

```
⏸ waiting (+2 more): Bash git push origin main   [Approve] [Deny]

solix 3 active · 4 idle · $1.25                  [Hide]
```

It draws nothing unless Solix is running on `127.0.0.1:4242`, so it is
harmless to install before you have Solix. `/solix-band off` hides it.

The command text is always drawn beside the buttons, never a bare count —
the same rule the browser panel enforces, so that neither surface can be
used to approve something you have not read.

## Where this fits

The advisors watch and advise. They cannot stop anything: a prompt is a
request to the model, and a model can decline it.

[Solix](https://www.solixsys.com) is the layer underneath — a real
`PreToolUse` hook that holds a command until you answer, fails closed when it
cannot reach you, and refuses a destructive one outright. If the crew is
useful, that is the part the crew cannot do for you.

```
npm i -g @shmulikdav/solix
solix
```

## Provenance

Install these only from `shmulikdav/Solix` on GitHub, or Solix itself from
`@shmulikdav/solix` on npm. Nothing here ships a binary, an `.exe` or a
`.dll`; a copy that does is not ours.

What Solix itself writes, and nothing else:

| Path | What |
| --- | --- |
| `~/.claude/settings.json` | its hook entries, merged — backed up first, and `solix uninstall` removes only its own |
| `~/.claude/agents/` | the advisor definitions |
| `~/.solix/` | hooks, skills, the local SQLite database, worktrees |

It runs on `127.0.0.1`, keeps a local database, has no account and sends no
telemetry. The hooks are plain shell scripts you can read before you trust
them.
