# Solix — a 10-minute first look

Hi! I'm sending you something I've been building. It's called **Solix** —
think of it as **air traffic control for AI assistants**. When you have
several AI agents working on different things at the same time, Solix
shows them all at once as planets orbiting a sun, so you can see who's
busy, who needs your input, and what they're doing — all at a glance.

This guide walks you through seeing it for yourself in about 10 minutes.
You don't need to be a developer. You'll copy a few lines into a
Terminal window — that's it.

---

## What you'll need

You need two things on your computer. If you don't have them, the
install commands are below.

| What | Why |
|------|-----|
| A Mac (or Linux PC) | The walkthrough is written for macOS Terminal |
| **Node.js** version 20 or newer | The thing that runs Solix |

You **don't** need Claude Code installed yet. We'll get the full
experience using a built-in demo. (At the end I'll show you how to
connect a real Claude Code session if you want to.)

### How to install Node.js (skip if you already have it)

Open the Terminal app on your Mac (press **Cmd+Space**, type
`Terminal`, press **Enter**), then paste this and press Enter:

```sh
curl -fsSL https://fnm.vercel.app/install | bash
```

Close Terminal, reopen it, then run:

```sh
fnm install 22
```

Verify it's installed:

```sh
node --version    # should print v22.x.x or similar
```

If it prints an error, ping me before continuing.

---

## Step 1 — Get Solix (1 minute)

We're going to install Solix from npm. In Terminal:

```sh
npm i -g @shmulikdav/solix
```

**What you should see:** a few lines of "added N packages" text, then
your prompt comes back. Solix is now installed — the `solix` command is
available from any folder.

---

## Step 2 — Start Solix (10 seconds)

```sh
solix start
```

**What you should see:** A big ASCII banner with **SOLIX** in it, then
something like:

```
[solix] server listening on http://127.0.0.1:4242
[solix] start any `claude` session to see your first planet appear
```

🎉 **Solix is now running.**

> **Important:** keep this Terminal window open. As long as you see the
> SOLIX banner, Solix is alive. If you close this window, the
> visualization stops working.

---

## Step 3 — Open the visualization

In your web browser (Chrome, Safari, Firefox — any modern one), go to:

**http://127.0.0.1:4242**

**What you should see:**

- A **sun** in the middle of a starfield
- **5 small colored planets** orbiting close to the sun:
  - 🟣 Compass (purple) — the Product Manager
  - 🟠 Forge (orange) — the Builder
  - 🔵 Lumen (cyan) — the UX/UI designer
  - 🟢 Argus (green) — the Code Reviewer
  - 🔴 Sentinel (red) — the Security Auditor
- A "**SOLIX**" logo top-left, "CONNECTED" badge, stats on the right

These 5 planets are **built-in AI advisors** — agents Solix ships with
that play specific roles. They live close to the sun because they're
"crew", part of mission control.

You may also see a Welcome card walking you through the same steps as
this guide. Click **Got it** to dismiss it.

---

## Step 4 — Light up the galaxy with the demo

Right now the system is empty (no real agents are running). Let's fill
it with fake activity so you can see what Solix looks like when it's
busy.

**Open a *second* Terminal window** (in the Terminal app: **Cmd+N**).

In the new window:

```sh
solix demo
```

**What you should see in the browser, immediately:**

1. **Three new planets** appear in outer orbits — these are pretend
   AI agents working on tasks
2. One planet **pulses red** — that's an agent asking permission
   ("can I run `git push origin main`?")
3. One planet looks **bloated and orange** — that's an agent that's
   used 87% of its memory; the orange flare is a "your agent is
   running out of room" warning
4. **Compass** also appears as a bigger planet in the outer ring with
   a **gold ring around it** — that means it's been "pinned" (always
   running, on standby)
5. You may see **comet-like streaks** — those are individual actions
   the agents are taking (reading files, editing code)

This is what mission control looks like for someone running 3-4 AI
agents at once.

---

## Step 5 — Try clicking around

Click any of the small **inner-ring planets** (Compass, Forge, etc.).
A panel slides in from the right.

**What you should see:**

- The advisor's codename and role (e.g., "Compass — Product Manager")
- A description of what they do
- A **Context envelope** section you can expand
- An **Invoke** button + **Pin** button

The "Context envelope" is the cool part. It shows you the **exact
prompt Solix would send to that advisor** — including a summary of
recent work and the right question for that advisor's role. This is
how Solix keeps each AI agent focused without dumping everything onto
it.

Press **Escape** to close the panel.

---

## Step 6 — Try the keyboard shortcuts

| Key | What it does |
|-----|--------------|
| **G** | Opens the **Galaxy panel** — share or import a Solix setup |
| **Y** | Approves a pending permission request |
| **N** | Denies a pending permission request |
| **Escape** | Closes any open panel |

Press **G** now. The Galaxy panel slides in. You can:

- **Download manifest** — saves your current Solix setup as a small
  file you could send to a teammate
- **Import** — load someone else's setup

This is how a team standardizes their AI workflow: one person sets it
up, exports it, the rest pull the same configuration in one click.

---

## Step 7 — (Optional) Connect a real Claude Code session

If you have **Claude Code** installed, this is where it gets *really*
fun. If you don't, skip to Step 8.

**Open a third Terminal window** (Cmd+N), then:

```sh
solix install
```

This is a one-time setup. It tells Claude Code to ping Solix whenever
it does anything. You should see green ✓ marks.

Now in any folder on your computer, run:

```sh
claude
```

**Watch the browser:** within one second, a **new planet appears** in
the outer ring. That's *your real Claude Code session*, live.

Type any prompt at Claude (e.g., "list the files in this folder").
The planet will:

- Get **brighter and warmer** — it's working
- Shoot off **little comets** — each one is a tool call (reading a
  file, running a command)
- **Cool down** when Claude finishes

You're now watching a real AI agent work, in real time. Run two or
three `claude` sessions in different folders and watch the whole
solar system come alive.

---

## Step 8 — Stopping Solix

When you're done:

1. Switch to the **first Terminal** (the one with the SOLIX banner)
2. Press **Ctrl+C**

The server stops. The browser tab will say "OFFLINE" in red. You can
close the tab.

Everything is saved at `~/.solix/solix.db` — when you start Solix again,
your advisors and missions will still be there.

To start it back up later, just open Terminal and run:

```sh
solix start
```

…and visit `http://127.0.0.1:4242` again.

---

## When something doesn't work

| Symptom | Fix |
|---------|-----|
| `command not found: solix` | Re-run `npm i -g @shmulikdav/solix`; make sure `node --version` prints v20+ |
| `Error: listen EADDRINUSE :::4242` (port in use) | Add `--port 5454` to the start command and visit `http://127.0.0.1:5454` |
| Browser shows OFFLINE | Make sure the SOLIX-banner Terminal is still running |
| Nothing happens when I run `claude` | Make sure you ran `solix install` first (Step 7) |
| The text in step 2 was huge and now I can't find the URL | Scroll up in that Terminal — the line ends with `http://127.0.0.1:4242` |

If you hit something not on this list, take a screenshot of the
Terminal and send it to me — I'll help.

---

## What you just saw — and why it matters

In 10 minutes, you've seen:

1. **One screen showing all your AI agents at once.** No more juggling
   five Terminal tabs to remember what each one was doing.
2. **Visual at-a-glance status.** Red flares mean "I need you now";
   orange means "I'm running out of room"; comet streaks mean "I'm
   actively working." You react in seconds, not minutes.
3. **Built-in roles.** A team of named advisors (PM, Builder, UX,
   Reviewer, Security) ready to be pointed at your work — each one
   already knows its job.
4. **Shareable setups.** Your AI workflow becomes a single file other
   people can import.
5. **Real-time visibility.** When Step 7 worked, you watched a real AI
   agent's thoughts appear as motion in space.

That's Solix. Tell me what felt obvious, what felt confusing, and
what you'd want it to do next.
