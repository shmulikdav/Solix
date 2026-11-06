# Contributing to Solix

Solix sits between an agent and your machine, so the bar is not "the tests
pass". It is **"the product does what it says"**. Most of what went wrong here
was not a crash. It was an overclaim: the README, the site or a log line said
Solix did X, and it did X-minus-something. The rules below exist to catch that.

## Build from source

```sh
pnpm install
pnpm --filter @solix/web prepare-assets   # optional: CC-licensed textures, ~3 MB
pnpm -r build
node packages/cli/dist/index.js start --no-wire --port 4300
```

`--no-wire` leaves `~/.claude` alone; drop it to test against real Claude Code
sessions. Point `SOLIX_HOME` at a scratch folder to keep a dev server's
database away from your real one. Textures are not part of `pnpm build` because
that would put a network fetch in every compile; without them the scene falls
back to procedural spheres.

```sh
pnpm dev            # server (:4242) and web (:4243, hot reload, proxies /api /events /ws)
pnpm typecheck
pnpm test           # vitest, every package
pnpm claims:check   # the claims ledger is in sync (see below)
```

| Package | What |
|---|---|
| `packages/shared` | Types and the wire protocol |
| `packages/server` | Hono + `ws` + better-sqlite3: the event router, the gate, rules, Maestro, the launcher |
| `packages/web` | React + react-three-fiber: the galaxy, List, Missions, panels |
| `packages/cli` | The `solix` command and the hook scripts (`packages/cli/hooks/*.sh`), the only package published to npm |
| `packages/agents`, `packages/skills` | The advisor definitions and the bundled skill pack |
| `plugin/` | The Claude Code plugins (`solix-crew`, `solix-band`) |

The hook scripts have three load-bearing properties: `--max-time` on every
request, `|| true` then `exit 0` so a hook never fails the agent's action, and
no output to the agent's stdout except a gate decision. Keep all three.

## Verify to fail

A test that passes is not evidence until you have seen it fail.

For any fix or new behaviour:

1. Write the test.
2. **Break the code it protects** (revert the fix, delete the check, flip the
   condition) and watch *that* test go red, for the reason you expect.
3. Put the code back and watch it go green.

Write down what you broke in the PR. A test that stays green when its fix is
reverted proves nothing and gets rewritten. Several in this repo were, and the
history says so in their comments.

Two more habits that have paid for themselves:

- **Test at the surface a reader meets.** Most of the defects in
  [`docs/CLAIMS.md`](docs/CLAIMS.md) were correct in a function and wrong in
  what the user saw: the environment never reached the hook, the count printed
  was the page size. Where you can, assert on the command's output, the HTTP
  response or the rendered text.
- **Use the real thing when the property is about the real thing.** The
  session-liveness tests spawn real processes, because the claim is about what
  the operating system says.

When a comment explains *why* code is the way it is, include what was measured
and when (e.g. "Measured on 2026-11-03: 481 sessions, 464 idle"). It stops the
next person from "simplifying" the fix away.

## The claims ledger

Every public promise Solix makes is a row in [`docs/CLAIMS.md`](docs/CLAIMS.md),
bound to the test that fails when it stops being true. `claims.test.ts` enforces
it in both directions: a row with no test fails, and a `CLAIM-` id in a test with
no row fails.

**If you change a sentence in the README, the site, a release note or a log
line that promises behaviour, find its claim.** If there isn't one, either add
it or soften the sentence. To add one:

1. Add a row to the table in `docs/CLAIMS.md` with a new `CLAIM-` id.
2. Put the id in the `describe()` of the test that holds it.
3. Verify to fail.
4. `pnpm claims` regenerates `claims.json`, and `pnpm claims:check` must pass
   (CI and the release script run it).

The website vendors `claims.json`, and its own test refuses governance wording
that isn't next to a claim id. So a claim removed here eventually breaks the
site's build, which is intended.

## The eval

Some numbers (holds per task, cost, wall time) can only be measured with a real
agent, so they aren't in CI. The harness is in [`scripts/eval/`](scripts/eval),
and [`docs/EVAL.md`](docs/EVAL.md) has the method and the past results.

```sh
SOLIX_EVAL_DIR=/tmp/solix-eval scripts/eval/run.sh
```

It runs one fixed task (`scripts/eval/SPEC.md`) against a running Solix and a
real `claude`, on your account, and records holds, cost, wall time,
interventions and the result. Run it before a release that changes the gate,
the rules or Maestro, and put the numbers in the release notes, or say plainly
that they weren't re-measured.

## Pull requests

- Branch from `main`. One concern per PR.
- The description says what changed and **why**, what you broke to verify the
  test, and anything you checked by hand (with the command).
- `pnpm typecheck`, `pnpm test` and `pnpm claims:check` pass.
- User-visible changes get a line under `## [Unreleased]` in
  [`CHANGELOG.md`](CHANGELOG.md), written for the person running Solix, not
  for the code.
- **Security problems are not PRs or issues.** Report them privately: see
  [`SECURITY.md`](SECURITY.md).

## Releasing

Only `@shmulikdav/solix` (`packages/cli`) is published. **Pushing a `v*` tag is
publishing:** `.github/workflows/publish.yml` runs the suite, `claims:check` and
an install-the-tarball check, then `npm publish --provenance`. npm only allows an
unpublish within 72 hours, so the checks happen before the tag.

1. **Prepare the release in a PR:**
   - bump `version` in `packages/cli/package.json`;
   - move `## [Unreleased]` in `CHANGELOG.md` to `## [x.y.z] — date`;
   - write `docs/releases/vx.y.z.md`, with front matter `tag`, `title` and
     `latest`.
2. **Merge it.**
3. **On an up-to-date `main`, tag it:**
   ```sh
   pnpm release:tag --dry-run
   pnpm release:tag
   ```
   It fetches, then refuses if the tree is dirty, you're not on `main`, `main`
   isn't in sync with origin, `CHANGELOG.md` has no section for the version,
   the version is already on npm, or the tag already points elsewhere. Then it
   asks you to type the version before it pushes the tag. (The tests and
   `claims:check` run in the publish workflow, before `npm publish`.) Don't tag
   by hand: every check in it is there because that step went wrong once.
4. **Wait for the publish workflow,** then `npm view @shmulikdav/solix version`
   until it shows the new version.
5. **Publish the release notes:**
   ```sh
   pnpm release:notes vx.y.z
   ```
   It writes the GitHub release body from the file with `gh`, using
   `--verify-tag`. Don't paste release notes into the GitHub UI: copying the
   rendered text drops the markdown.
6. **Update the website.** In the website repo, run `node scripts/sync-claims.mjs`
   (it vendors `claims.json` and the latest version), open a PR, merge it, and
   wait until Lovable shows the merge before clicking Publish. Then
   `node scripts/check-deployed.mjs` confirms the live site matches npm.
