# Solix reference

The parts of Solix that are not the gate: how the galaxy encodes what it
shows, the advisors, skills, shareable galaxies, textures, and how context is
handed between agents. Start with the [README](../README.md) for the gate,
Maestro and install; this page is the detail behind "Also in the box".

## The galaxy's visual language

| Concept | Visual |
|---|---|
| User / mission control | Sun |
| Project / workspace | Solar system |
| Claude Code session | Planet |
| Subagent (Task tool) | Moon orbiting its planet |
| **Built-in advisor (PM, Builder, UX, …)** | **Inner crew ring planet near the sun** |
| **Pinned advisor (always-on)** | **Outer planet with gold accent ring** |
| **Skill (Anthropic + Solix pack)** | **Asteroid in the outer belt** |
| Active session | Bright emissive, faster orbit |
| `awaiting_permission` | Red pulsing flare |
| `awaiting_input` | Yellow flare |
| `plan_review` | Saturn-like ring |
| Tool call | Comet streak |
| Context usage | Planet size (0.55 → 1.05) |
| Model | Surface color (opus=purple, sonnet=blue, haiku=cyan) |

## Advisors — the built-in crew

Solix ships 15 advisor agents installed into `~/.claude/agents/`:

| # | Codename | Role | Default |
|---|---|---|---|
| 1 | Compass | Product Manager | enabled |
| 2 | Forge | Builder | enabled |
| 3 | Lumen | UX/UI Designer | enabled |
| 4 | Argus | Code Reviewer | enabled |
| 5 | Sentinel | Security Auditor | enabled |
| 6 | Mira | Test Engineer / QA | opt-in |
| 7 | Echo | Devrel / Docs | opt-in |
| 8 | Helios | Performance Engineer | opt-in |
| 9 | Vale | Release Engineer | opt-in |
| 10 | Atlas | Skill Curator | opt-in |
| 11 | Cinder | Debugger / Incident | opt-in |
| 12 | Delta | Data / DB Engineer | opt-in |
| 13 | Spire | Architect | opt-in |
| 14 | Ledger | FinOps / Cost | opt-in |
| 15 | Maestro | The Conductor — decomposes a goal into a plan | opt-in |

```sh
solix advisors list
solix advisors enable mira
solix advisors pin compass     # always-on planet (uses real claude binary;
                               # set SOLIX_FAKE_CLAUDE=1 for synthetic dev mode)
solix advisors unpin compass
```

**In the browser:** opt-in advisors now appear as dim **ghost
planets** on a faint outer ring — click one and press **＋ Add to crew** to
enable it. Or press **C** (or the **✦ Crew** button) to open the **crew
roster**: every advisor, grouped active vs available, with one-click
Enable / Disable / Pin. Click an advisor in the inner ring to read its
system prompt, hand it a brief, and Invoke it on the focused planet.

## Skills — the asteroid belt

Solix discovers SKILL.md manifests from two sources:

- `~/.claude/skills/` — the upstream Anthropic catalog
- `~/.solix/skills/` — Solix's bundled pack (4 skills:
  `mission-summary`, `permission-explainer`, `galaxy-publish`,
  `advisor-prompt`)

```sh
solix skills list
solix skills install solix:mission-summary --project <projectId>
```

Click any asteroid in the browser to read the manifest and see which
advisors require it.

## Galaxies — share your space

A galaxy is a portable JSON manifest of your enabled advisors, discovered
skills, and known projects. Each user runs Solix locally; galaxies move
between users.

**Local file (no servers):**

```sh
solix galaxy export ./my-setup.galaxy.json --name "Indie Hacker"
solix galaxy import ./my-setup.galaxy.json
solix galaxy import https://gist.githubusercontent.com/.../my.galaxy.json
```

**Opt-in cloud registry:** point Solix at any HTTP registry that speaks
`PUT /v1/galaxies/:slug` and `GET /v1/galaxies/:slug`:

```sh
export SOLIX_REGISTRY_URL=https://registry.example.com
export SOLIX_REGISTRY_KEY=...
solix start

# anywhere, anytime
solix galaxy publish shmulik/dev --name "Shmulik Dev"
solix galaxy install shmulik/dev
```

**Safety property of imports:** they only flip advisor `enabled` flags and
record project hints. They never spawn pinned advisors, run shell commands,
auto-install skills to the filesystem, or schedule tasks. You stay in
control.

## Textures (optional, for building from source)

`prepare-assets` pulls a small set of CC-licensed planet + sky textures
(~3 MB total) from public CDNs. It runs automatically on the **publish**
path (`prepublishOnly` / `pnpm release`), so a released build ships
textured. It is deliberately NOT part of `pnpm build` — that would put a
network fetch in every compile and break offline and CI builds — so for
local development run it once yourself:

```bash
pnpm --filter @solix/web prepare-assets
```

The textures it fetches:

| Texture | Used by | Source |
|---|---|---|
| `milky_way.jpg` | Sky | jsDelivr — `jeromeetienne/threex.planets` (galaxy_starfield) |
| `sun.jpg` | The sun | jsDelivr — `jeromeetienne/threex.planets` |
| `saturn.jpg` + `saturn_ring.png` | Compass advisor | jsDelivr — `jeromeetienne/threex.planets` |
| `mars.jpg` | Forge advisor | jsDelivr — `jeromeetienne/threex.planets` |
| `earth.jpg` + `earth_clouds.png` | Lumen advisor | three.js examples |
| `jupiter.jpg` | Argus advisor | jsDelivr — `jeromeetienne/threex.planets` |
| `moon.jpg` | Sentinel advisor | three.js examples |

The fetch script tries multiple mirrors and never fails a build: if a
download doesn't land, the scene falls back to procedural spheres. That
fallback is enforced by an error boundary around every textured body, so
a missing or corrupt texture degrades the *look* and nothing else — it
cannot take the UI down. (It used to: the fallback was wired with
`<Suspense>`, which only covers loading, not failure, so one failed
texture blanked the whole app. Fixed — see `ErrorBoundary`.) Re-run
`prepare-assets` any time to re-attempt, and `pnpm smoke:browser` to
verify the UI in a headless browser.

To swap any texture for your own (e.g., a higher-res version from
[solarsystemscope.com/textures](https://www.solarsystemscope.com/textures/) —
their site is gated behind Cloudflare so manual download is the path),
drop a replacement file with the same name into
`packages/web/public/textures/`. The file is gitignored so it won't be
committed.

## Context management

Solix is opinionated about how context flows between agents.

**Mission summaries are the handoff currency, not transcripts.** Every
mission produces a `shortName` + (eventually) a `longSummary`. When you
Invoke an advisor, Solix builds a **context envelope** — a small,
structured prompt — by stitching together:

- the advisor's role description (from its `.md` file),
- the focused planet's `cwd`, model, status, and current context %,
- the last 3 missions on that planet (summary + files touched + tool
  counts),
- a role-specific default ask if you didn't write a brief,
- a budget warning if the target session is ≥80% (suggest /compact at
  ≥90%).

This is the cheapest possible handoff: an advisor gets enough to be
useful without the cost of replaying full transcripts.

You can preview the envelope before sending — it shows up as an
expandable section in the AdvisorPanel, or via:

```sh
curl 'http://127.0.0.1:4242/api/advisors/compass/preview?targetSessionId=<id>'
```

**Visual context warnings:**

| Context % | Visual |
|---|---|
| <80% | Planet at normal size |
| 80–89% | Orange flare, slow pulse |
| ≥90% | Red flare, faster pulse + planet visibly bloated |

**Where context usage comes from:** every session has the field, and it
travels over the WebSocket as `context_update`. Nothing reads it from a real
session's transcript yet, so a real planet stays at normal size. It is set
through the API (`setContextUsage()` in the router), which is what the demo
seeder uses.
