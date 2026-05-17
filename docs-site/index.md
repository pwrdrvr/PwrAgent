---
layout: home
title: PwrAgent docs
---

<figure class="screenshot-hero">
  <img src="{{ '/assets/screenshots/desktop-hero.png' | relative_url }}" alt="PwrAgent desktop: Directories lens grouping threads under PwrAgnt and PwrSnap repos, a mid-conversation thread about OCR image tags with the agent's reply showing edited files and passing pnpm lint, four messenger status icons (Telegram, Discord, Slack, Mattermost) in the title bar, profile selector reading 'profile:default, codex:default', and per-thread model / Full Access / Fast mode / Worktree controls above the composer.">
  <figcaption>The PwrAgent desktop with four messengers paired, threads grouped by repo, and the per-thread model / access / worktree controls live.</figcaption>
</figure>

# What PwrAgent is

PwrAgent is an **agentic coding environment in the same family as
Codex Desktop** — a desktop app where you spawn a Codex thread, point
it at a directory, watch the agent work, approve commands, and ship
the result. If you already know Codex Desktop, you know the shape:
threads, transcripts, per-thread model and access-mode pickers,
permission prompts when the agent wants to do something destructive.

The two apps **share thread state by default**. Open Codex Desktop
and your PwrAgent threads are there; open PwrAgent and your Codex
Desktop threads are there. They read and write the same on-disk
session DB, so you can start a thread in one and pick it up in the
other without thinking about it.

When you *don't* want that — work code in one window, side-project
code in another, a sandbox for trying things in a third — you create
**isolated profiles**:

- A **PwrAgent profile** (via `--profile work`) carries its own
  config, session state, messaging credentials, and Codex pairing.
- A **Codex profile** (a Codex-side concept) carries its own
  authentication and per-Codex defaults.
- You can bind a PwrAgent profile to a specific Codex profile, then
  launch as many copies of PwrAgent simultaneously as you want — one
  per profile — each isolated from the others. Work in one Dock
  icon, personal in another, side projects in a third. Threads,
  authentication, and messaging credentials never cross the
  boundary.

See [Desktop → Multiple profiles](desktop/#multiple-profiles) for the
worked setup.

# Messaging from anywhere

PwrAgent's other half is **messaging integration**. Pair a bot once
on **Telegram, Discord, Slack, Mattermost, Feishu / Lark, or LINE**,
and you can resume an existing thread or start a new one from your
phone — review the last reply, send the next prompt, approve a
Default-Access command — without opening the laptop.

It's built for the cases where the laptop isn't an option: a phone
on cellular, a hotel WiFi connection that drops every two minutes,
an iPad you're using on the couch. The messaging path runs as a thin
transport on top of your platform of choice; the agent itself stays
on your laptop, so resilience to network blips is mostly the chat
platform's problem (which they're already good at solving).

See [Messaging](messaging/) for the per-platform setup walkthroughs
and the end-to-end [Using Codex via Messaging](using-codex/) guide.

# How well does it actually work?

The author **uses PwrAgent as their primary coding environment**.
Hundreds of PRs in this repository and others were created or
reviewed through it — substantial features, refactors across package
boundaries, bug investigations that span days. The messaging surface
gets daily use from a phone for triage, approval, and "what did you
end up doing while I was away" check-ins on long-running threads.

That doesn't make it the right tool for everybody, but it does mean
the rough edges that would have stopped a serious user have already
been filed off. The honest list of what's still missing today and
what's on the roadmap lives at
[Desktop → Not yet](desktop/#not-yet-missing-from-the-desktop) and
[Desktop → Coming soon](desktop/#coming-soon).

# What PwrAgent is going to be

The shape above is **the starting point, not the destination**.
There are plans on the roadmap (better thread archival, branch
auto-naming, monitor cards that survive restarts, more messaging
providers, a tighter loop between Codex environments and worktrees),
but the more interesting question is **what *you* want to build on
top of this**.

If you've ever wished a coding agent worked some specific way that
no existing tool gets right — that's the kind of thing this codebase
is set up to absorb. Cleanly layered packages with hard dependency
boundaries, a forward-compatible local data layer that doesn't
fight you on schema changes, and a per-platform messaging contract
small enough that adding a seventh provider is a few-day task
rather than a few-month one.

We'd genuinely like to see what you bring. Patches, issue threads,
forks that go in a different direction — all of it. Start with the
[GitHub repo](https://github.com/pwrdrvr/PwrAgent) for the codebase,
the architecture notes, and the contributor's path.

# Get started

- **Download** the latest signed macOS build from the
  [GitHub Releases page](https://github.com/pwrdrvr/PwrAgent/releases).
- **Install** by opening the DMG and dragging PwrAgent into
  Applications. The build is Developer ID-signed and Apple-notarized,
  so first launch should be a single Gatekeeper prompt — no
  right-click-open ceremony.
- **(Optional) Pair a messenger** from **Settings → Messaging**.
  See the [Messaging](messaging/) section for the per-platform
  walkthroughs.

# Browse the docs

- **[Desktop](desktop/)** — sidebar lenses, thread workspaces (Local
  and Worktree), Codex environments, per-thread settings, multiple
  profiles, and what's still on the roadmap.
- **[Messaging](messaging/)** — drive Codex threads from Telegram,
  Discord, Slack, Mattermost, Feishu / Lark, or LINE. End-to-end
  usage guide, per-platform setup, rate limits, the streaming-
  responses tradeoff, and the webhook security note.
- **[Settings](settings/)** — application discovery (terminal,
  editor, git, gh CLI), profiles, worktree storage, Codex App
  Server / Codex Desktop coordination, the experimental flags.

# License

PwrAgent is MIT-licensed, created by PwrDrvr LLC. See the
[LICENSE](https://github.com/pwrdrvr/PwrAgent/blob/main/LICENSE) and
[THIRD\_PARTY\_LICENSES](https://github.com/pwrdrvr/PwrAgent/blob/main/THIRD_PARTY_LICENSES)
files in the repo.
