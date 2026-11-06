# Solix — a 15-minute demo for PMs

Hi —

You spend your day **orchestrating people, work, and decisions across
multiple streams**. AI coding agents (Claude Code, Cursor, etc.) are
starting to do real work — and the moment your team has more than two
of them running, you have the same problem you have with humans: *who's
busy, who's blocked, who needs me, what shipped today?*

**Solix is mission control for that.** Every AI agent on your team is a
planet. You're the sun. You see the whole portfolio at once, react
when one needs you, and ship a shared "way we run AI here" standard
that the rest of your team can pull down in one command.

This walkthrough takes about 15 minutes. By the end you'll have:

- A live solar-system view of AI agents working in real time
- A pre-built crew of role-based AI advisors (PM, Builder, UX,
  Reviewer, Security) ready to invoke on any project
- An exportable "team standard" you could share with engineers tomorrow

You don't need to be technical, but you'll spend ~5 minutes in
Terminal. If you've ever pasted one command into it, you'll be fine. If
you haven't, the install steps below walk you through it.

---

## What you'll need

| Item | Why |
|---|---|
| A Mac (or Linux) | Walkthrough is written for macOS Terminal |
| **Node.js 20+** | Runs Solix |

You **don't** need Claude Code itself for the demo. We'll use a
built-in dummy mode so you can see the full visual story before
deciding to plug in real agents. The "real Claude" step at the end is
optional.

### One-time setup (skip if you've done this before)

Open the **Terminal** app on your Mac (press **Cmd+Space**, type
`Terminal`, press **Enter**), then paste:

```sh
curl -fsSL https://fnm.vercel.app/install | bash
```

Close Terminal, reopen it, then:

```sh
fnm install 22
```

Verify it worked:

```sh
node --version    # should print v22.x.x
```

If it errors, message me — I'll help.

---

## Step 1 — Get Solix

```sh
npm i -g @shmulikdav/solix
```

**You should see:** "added N packages" text, then your prompt comes back.

**The PM read:** Solix is a real, published npm package — one command to
install, no repo to clone, and the `solix` command works from any folder.

---

## Step 2 — Start Solix

```sh
solix start
```

**You should see:** a big ASCII **SOLIX** banner, then:

```
[solix] server listening on http://127.0.0.1:4242
```

> **Important:** keep this Terminal window open. It's running the
> system. Closing this window stops the demo. (Think of it like
> leaving your dashboard open.)

---

## Step 3 — Open the dashboard

In any browser: **http://127.0.0.1:4242**

**You should see:**

- A glowing **sun** in the center (that's you — mission control)
- **5 small colored planets** in a tight ring close to the sun

Those 5 planets are your **built-in advisor team**. They're not
real-time agents — they're *role-based prompts* Solix ships pre-loaded.
They cover the roles you'd hire for in any product team:

| Color | Codename | Role |
|---|---|---|
| 🟣 Purple | **Compass** | Product Manager |
| 🟠 Orange | **Forge** | Builder / Engineer |
| 🔵 Cyan | **Lumen** | UX/UI Designer |
| 🟢 Green | **Argus** | Code Reviewer |
| 🔴 Red | **Sentinel** | Security Auditor |

**The PM read:** *Solix ships an opinionated team.* Instead of every
engineer prompting Claude differently, the team uses a shared roster of
advisors with curated system prompts. Compass always reviews missions
through a PM lens; Argus always reviews diffs the same way. This is
the AI equivalent of writing your team's **competency framework** —
once.

---

## Step 4 — Light up the system with simulated activity

Open a **second Terminal** (in Terminal: **Cmd+N**), then:

```sh
solix demo
```

**You should now see in the browser:**

1. **Three new planets** in outer orbits — simulated agents working on
   tasks
2. One planet **pulsing red** — an agent waiting for a decision from
   you (it wants to run `git push origin main`)
3. One planet **bloated and pulsing orange** — an agent at 87% of its
   memory budget
4. A **gold-ringed Compass** in the outer ring — that's the PM advisor
   "pinned" as always-on, watching the project
5. Brief **comet streaks** — individual tool calls (file reads, edits,
   shell commands)

This is what's normally invisible with AI agents. **At any given
moment in your team, this is happening.** You just don't see it.

**The PM read — three minutes that pay for the rest of your week:**

| What you see | What it actually means | Why it matters |
|---|---|---|
| Red flare | Agent stuck on a permission decision | You unblock it in 1 second instead of finding it 4 hours later |
| Orange flare | Agent running out of context | You suggest "compact the conversation" before the work degrades |
| Comet streaks | Real-time tool calls | You can see *what* the agent is touching — files, commands — without reading transcripts |
| Gold-ringed advisor | Pinned crew member | Always on, available to invoke without spinning up a new session |

This is the **single screen** you get as a PM. You react to colors,
not to walls of log text.

---

## Step 5 — Use the PM advisor

Click the **purple Compass** planet in the inner ring.

A panel slides in from the right. You see:

- Compass's role description ("Reviews missions, maintains a backlog,
  surfaces feature ideas. The product navigator.")
- An **Invoke** button
- A **Pin** button (already pinned in this demo)

Now click the small **▸ Context envelope** section. Expand it.

**You should see** the *exact prompt* Solix would hand to Compass —
including a summary of what the focused planet has been working on,
a list of files it's touched, and a role-specific question
("Review the recent missions and propose 1–3 next features in priority
order").

**The PM read — this is the real win.** You're looking at how Solix
**briefs** an AI advisor. It doesn't just dump a transcript. It
constructs a structured handoff:

- *Who you are* (role)
- *What's been happening* (recent work as one-line summaries, not full
  transcripts)
- *What I need from you* (a role-specific ask)

This is how you'd brief a real PM joining a project mid-flight. It
keeps the advisor focused, keeps token usage cheap, and produces
better answers than "here's the whole conversation, what do you
think?"

> **What you'd say in a stakeholder meeting:** "Solix forces us to
> brief AI advisors the way we'd brief a person — not by dumping
> raw history but by handing them a one-paragraph context. Output
> quality goes up, cost goes down, and the result is reproducible."

---

## Step 6 — Standardize across the team

Press **G** on the keyboard. The **Galaxy panel** slides in.

You'll see:
- Stats: "5 advisors · 5 skills · 5 sessions"
- A **Download manifest** button
- An **Import** section (URL or paste)

Click **Download manifest**. A small file (`my-galaxy.galaxy.json`)
drops to your Downloads folder.

**Open that file** in any text editor. You'll see something like:

```json
{
  "version": 1,
  "name": "My Galaxy",
  "advisors": [
    { "role": "compass", "pinned": true, "model": "opus" },
    { "role": "forge",   "pinned": false, "model": "opus" },
    { "role": "argus",   "pinned": false, "model": "opus" },
    ...
  ],
  "skills": [...],
  "projects": [...]
}
```

**The PM read — this changes how teams adopt AI.**

This file is your team's **AI operating standard, version-controlled**:

- *Which advisors* the team uses (and which are off)
- *Which skills* are installed (e.g., "always run security review on
  diffs")
- *Which models* (Opus for Compass, Sonnet for Forge — cost-tuned)

Drop this file in your team's GitHub repo as `team.galaxy.json`. Now
every engineer joining the team runs:

```sh
solix galaxy import ./team.galaxy.json
```

…and they get the **same advisor crew, same skills, same defaults** as
everyone else. No more "how does Sarah use Claude differently from
Mike?"

> **What you'd say in your "AI strategy" doc:** "Solix lets us treat
> our AI workflow as a shared artifact. Onboarding a new engineer to
> our AI tooling is a one-line command. Updating the team's standard
> is a pull request to a JSON file."

---

## Step 7 — (Optional) Watch a real Claude Code session

If you have **Claude Code** installed (or want to install it now from
[claude.ai/code](https://claude.ai/code)), this is the live-fire demo.

Open a **third Terminal** (**Cmd+N**):

```sh
solix install
```

Green checkmarks confirm Solix is now wired into Claude Code. **One
time only.**

Now in any folder on your computer:

```sh
claude
```

**Watch the browser:**

- Within 1 second, a **new planet appears** in the outer orbit
- That's *your real Claude Code session*, live

Type any prompt at Claude (e.g., "list the files in this folder").
Watch:

- The planet **brightens and warms up** — Claude is thinking
- **Comets shoot out** — each one is a tool call (read, edit, bash)
- The planet **cools down** when Claude finishes

Run two `claude` sessions in different folders. Now you have **two
planets in flight, side by side**, with no need to alt-tab between
Terminal windows.

**The PM read — what you just saw is what your engineers' day looks
like.** Today they have 3 Terminal tabs and no idea what each agent is
doing. Solix makes their cognitive load drop to a single glance.

---

## Step 8 — Stopping

In the **first Terminal** (with the SOLIX banner), press **Ctrl+C**.

The browser tab will say "OFFLINE" in red. Close it.

Your data persists at `~/.solix/solix.db` — when you start Solix
again, your history, advisors, and pinned crew are all still there.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: solix` | Re-run `npm i -g @shmulikdav/solix`; check `node --version` prints v20+ |
| `EADDRINUSE :::4242` (port in use) | Add `--port 5454` and use that URL instead |
| Browser shows OFFLINE | The Terminal with the SOLIX banner closed — start it again |
| Step 7: nothing happens when I run `claude` | Make sure you ran `solix install` first |

If you hit something not on this list, take a screenshot of the
Terminal and send it to me.

---

## What you'd put on a slide

After 15 minutes, here's the elevator pitch you can take to your team:

**Problem.** AI agents are now doing real work, but tooling for
*managing* them is stuck in 2023. Engineers run 3-5 Claude Code sessions
in different Terminal tabs and have no shared visibility.

**What Solix gives you:**

1. **Single-pane mission control.** Every AI agent on the team is
   visible at once as a planet. Status (busy, blocked, asking
   permission, low on context) is communicated by *color and motion*,
   not text logs.

2. **Pre-built advisor crew.** Five role-based AI agents (PM, Builder,
   UX, Reviewer, Security) ship pre-configured with role-specific
   prompts. You invoke them with structured context, not raw
   transcripts.

3. **Shared team standard as a file.** Your team's AI operating
   model — which agents, which skills, which models — exports to a
   single JSON file. Check it into Git. Everyone imports the same
   one. AI workflow becomes an artifact you can review like any other
   PR.

4. **Real-time visibility into agent work.** Tool calls, file edits,
   permission requests — all visible as motion in the scene. You
   intervene in seconds, not after-the-fact.

**The metric to watch.** Time from "an agent needs me" to "I respond"
should drop from minutes (or hours, if you missed a Slack ping) to
seconds. Multiply by the number of agents your team runs per day.

**What's next.** Tell me what felt powerful, what felt unclear, and
what you'd want it to do that it doesn't yet.

---

*P.S. — Compass, the purple PM advisor, is itself an AI Product Manager.
Click it, paste a brief, hit Invoke. Yes, you can have an AI PM critique
your own backlog. It's surprisingly good. Ask me how.*
