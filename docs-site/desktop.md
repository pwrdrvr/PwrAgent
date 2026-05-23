---
layout: page
title: Desktop
permalink: /desktop/
---

# The PwrAgent desktop

The desktop app is where you live day-to-day. It reads and writes
the same on-disk session state Codex Desktop uses, so your threads,
transcripts, and authentication are shared between the two by
default — open either one and your work is there.

What makes the PwrAgent side worth running:

- **Per-thread settings** for model, reasoning effort, Fast mode,
  and access mode. Codex Desktop scopes these globally; PwrAgent
  lets a high-stakes refactor run on a stronger model under **Full
  Access** in one thread while a throwaway script runs on a cheaper
  model under **Default Access** in another, without the settings
  bleeding into each other.
- **Worktree workspaces** so the agent can rip apart a branch in a
  `git worktree` PwrAgent manages while your main checkout sits
  undisturbed. Hand a thread off between Local and Worktree when
  it's ready to land.
- **Codex environment hooks** — when you spawn a thread on a
  worktree, PwrAgent can run the environment's setup hook (install
  deps, warm caches, run codegen) and stream the output into the
  transcript before the agent takes its first turn.
- **In-place Markdown composer** — ```` ``` ```` opens a code block,
  `>` opens a blockquote, bullet and numbered lists auto-continue.
  Codex Desktop doesn't have this yet.
- **Persistent draft history** — every keystroke autosaves to a
  per-profile store. Press <kbd>↑</kbd> in an empty composer to
  recover and cycle through the last 20 drafts (unsent *and* sent).
  Drafts survive thread switches, sidebar refreshes, settings
  overlays, and full app restarts.
- **Profile isolation** — two layered profile mechanisms (PwrAgent
  + Codex) compose into anything from "one install, one identity"
  to "N installs running side-by-side with isolated auth and
  isolated messaging credentials." Work / personal / side-projects
  separation without juggling SSH keys.
- **Messaging as a first-class concept** — pair a bot on any of six
  platforms (Telegram, Discord, Slack, Mattermost, Feishu / Lark,
  LINE) and you can resume or start threads from your phone. See
  [Messaging](../messaging/) for the operator-facing setup; this
  page covers the *desktop* side.

State lives under `~/.pwragent/` (overridable with `PWRAGENT_HOME`
or `--profile <name>`). No cloud relay and no PwrAgent-owned
account — see [Settings](../settings/) for how the desktop
discovers your local Codex install and how authentication works.

Install the desktop from GitHub Releases. macOS uses the signed DMG; Linux
uses Debian packages with manual upgrades documented in
[Linux Install](../linux/).

The rest of this page is the operator-facing tour of what the
desktop **does**, what's not in it yet, and what's on the roadmap.

## What's in the desktop today

### Sidebar lenses

{% include figure.html
   src="/assets/screenshots/desktop-recents.png"
   alt="Sidebar with the Updated lens active, showing pinned threads at the top and recent activity below"
   caption="The <strong>Updated</strong> lens, populated. Pins sit in a statically-ordered shelf at the top; unpinned threads sort by most-recent activity below."
%}

The left sidebar carries three thread lenses you can switch between
with the segmented toggle at the top of the list. All three start
from the same pool of active (non-archived) threads — they differ
only in how they sort and group:

| Lens | Sort | Grouping |
|---|---|---|
| **Updated** *(default)* | Most-recently-updated first. Active threads bubble up as the agent posts. | Flat list with user-curated **Pins** pinned to the top in their own statically-ordered section. |
| **Created** | Most-recently-created first. **Stable sort** — threads don't jump around mid-work the way they do in Updated. | Same Pins section at the top. |
| **Directories** | Within each directory, most-recently-created first (stable). | Grouped by the project / repository the thread is rooted in. Per-directory **Pins** sit at the top of their group. |

Use **Updated** when you want "what's the agent doing right now"
front and center. Use **Created** when you'd rather the order stay
put while you work through a list. Use **Directories** when you're
deliberately switching between several repos and want them visually
separated.

#### Pins

A **pin** keeps a thread visible at the top of the list regardless
of activity. The pinned section is statically ordered (you set the
order yourself) and scrolls independently of the rest of the list,
so a long pin section never buries the rest of your threads.

In **Directories**, pins belong to their parent directory rather
than to the global list, so each directory gets its own statically-
ordered pin shelf.

The **Directories** lens also lets you pin entire directories
(and workspaces) above the divider so your active projects stay
on top regardless of which one most recently woke up. Pinned
directories carry over across restarts.

To pin or change pin order:

- **Pin or unpin:** right-click a thread or directory row and
  pick **Pin / Unpin** from the menu. The same menu is reachable
  from the three-dot overflow button on thread rows.
- **Drag to reorder:** drag a pinned row up or down inside the
  pinned section. Drag an unpinned thread or directory above the
  pinned divider to add it; drop it back below to remove it.
- **Keyboard reorder:** with a pinned row focused (Tab from the
  sidebar or click it once), press <kbd>⌘⇧↑</kbd> / <kbd>⌘⇧↓</kbd>
  to move it up or down. Same shortcut for pinned threads and
  pinned directories. The chips next to **Move Up** and **Move
  Down** in the right-click menu surface the same binding —
  discover once there, use anywhere.

#### Unread marker

When a thread you haven't actively viewed gets new agent output,
its row picks up an **orange cookie** — a small filled circle next
to the thread title. The cookie clears the next time you open the
thread (or select it in the sidebar). Same indicator across all
three lenses.

### Thread workspaces: Local and Worktree

Each PwrAgent thread is rooted in a project (a Git repository).
Within a project, a thread runs in one of two **workspaces**:

- **Local** — the working copy you'd normally check out. The thread
  shares your repo with whatever else you're doing in that directory.
- **Worktree** — a `git worktree` PwrAgent manages for you, isolated
  from your main checkout. The thread does its work in the worktree
  so your `main` (or whatever you have checked out) isn't disturbed.

Threads can be **handed off** between Local and Worktree from the
status card — PwrAgent moves the thread's working state and updates
the binding. Local-to-Worktree handoff asks which branch should
remain checked out in Local before it moves you over; Worktree-to-
Local handoff asks for confirmation.

<!-- screenshot: desktop-worktree-picker.png — Handoff dialog with Local-to-Worktree branch picker. See DOCS_SITE_SHOT_LIST.md. -->

Worktree storage location is configurable — see
[Settings → Worktrees](../settings/#worktrees).

### Codex environments

When you start a thread on a worktree, PwrAgent can run a **Codex
environment** before the thread takes its first turn. Environments
are configured at the Codex level (alongside `AGENTS.md` and
`.codex/` metadata) and PwrAgent surfaces them in the launchpad
alongside the model and access-mode pickers:

- Pick which environment to attach to the thread when you create
  the worktree.
- Optionally run the environment's **setup hook** (install
  dependencies, warm caches, run codegen) before the thread starts.
  Setup output streams live into the thread's transcript so you can
  watch it complete.
- Pick which **commands** the environment exposes for the agent to
  run during the turn. The agent can only invoke commands you've
  enabled.

<!-- screenshot: desktop-environments.png — Launchpad / composer with the Codex environment picker visible. See DOCS_SITE_SHOT_LIST.md. -->

Environments are usable today but **not yet editable inside the
PwrAgent UI** — you author them at the Codex level and PwrAgent
picks them up. In-app editing is on the roadmap.

### Per-thread settings

Unlike Codex Desktop, where model / reasoning effort / Fast mode /
permissions mode are global, PwrAgent scopes them **per thread**.
You can run an experiment on a cheaper model with **Default Access**
while a refactor runs on a stronger model with **Full Access** —
the settings stay scoped to their thread. Set them on the **Start
Card** before sending the first prompt, or on the bound-thread
status card afterward.

### Auto-naming

PwrAgent gives threads automatic names so the sidebar list is
scannable as it grows. The first prompt is the primary signal; the
agent's responses adjust the name as the thread takes shape. You
can rename manually from the thread header at any time.

### Access modes

The two access modes that gate what the agent can do:

- **Default Access** — the agent asks before executing
  potentially-destructive shell commands or writing outside the
  workspace.
- **Full Access** — no prompts. The agent runs commands and writes
  files freely within the workspace. Use deliberately.

The mode is per-thread (see above). Mid-turn changes queue at the
turn boundary — see
[Using Codex via Messaging → Start Card buttons](../using-codex/#start-card-buttons)
for the queueing details, which apply equally on the desktop.

### Approval surface

When a thread is in Default Access and the agent wants to run
something approval-gated, the desktop shows an inline approval card
inside the transcript. Approvals are mirrored to any bound messengers
so you can approve from wherever you happen to be reading the
conversation.

### Markdown composer

The composer parses Markdown as you type:

- ```` ``` ```` + space opens a code block.
- `>` + space opens a blockquote.
- `-` or `*` + space starts a bulleted list; press Enter on an empty
  bullet to exit.
- `1.` + space starts a numbered list; subsequent Enters keep the
  numbering going until you exit on an empty item.
- Standard inline formatting (`**bold**`, `*italic*`, `~~strikethrough~~`,
  `` `code` ``, links) renders as you type.

Codex Desktop doesn't have this yet.

### Undo / redo (per-thread)

While a thread is focused, <kbd>Cmd+Z</kbd> undoes the most recent
change to that thread's composer, and <kbd>Cmd+Shift+Z</kbd> (or
<kbd>Cmd+Y</kbd>) redoes. Each thread carries its own independent
undo stack — switching threads doesn't merge the histories, and
undo never crosses thread boundaries.

Undo also restores a `$skill` chip you just removed with
<kbd>Backspace</kbd>, recovering both the chip and its position in
the surrounding text — so an accidental delete doesn't cost you the
chip you spent time picking.

For recovery **across** threads or app restarts, see
[Composer draft history](#composer-draft-history--recovers-your-last-message)
below — the <kbd>↑</kbd> mechanic there reaches further back than
the per-thread undo stack does.

### Composer draft history (↑ recovers your last message)

Every keystroke in the composer is autosaved to a per-profile
store, including the text, any `$skill` chips, pasted images, and
any rich formatting you applied. Drafts survive **everything**
that historically lost them in other agent UIs:

- Navigating between threads
- Opening Settings and coming back
- A sidebar refresh
- Quitting and relaunching the app
- An undo / redo sequence that backs over what you typed
- Closing a thread without sending

To recover a previous draft, focus an **empty** composer and press
<kbd>↑</kbd> (ArrowUp). The composer fills with the most recent
candidate. Keep pressing <kbd>↑</kbd> to cycle further back through
up to **20 recent candidates** (per-profile); <kbd>↓</kbd>
(ArrowDown) cycles forward through the same list.

Candidates include:

- **Unsent drafts you abandoned** — anything you typed and walked
  away from.
- **Messages you've already sent** — recover what you said and
  re-send it (with edits) without retyping.
- **Drafts from other scopes** — if the current scope has no
  history, the recovery falls back to recent drafts from
  anywhere in the same PwrAgent profile.

The recovery cycle is anchored on the *blank composer* state.
Start typing once you've found the draft you want and the cycle
ends — the next <kbd>↑</kbd> will move the cursor in the usual way.

Draft history is **per PwrAgent profile** — switching profiles via
`--profile <name>` gives that profile its own independent history.
Drafts never leave your machine.

Codex Desktop doesn't have this yet either.

### Multi-message queueing

{% include figure.html
   src="/assets/screenshots/desktop-queued-turns.png"
   alt='Composer with a turn in flight on the "Convert OAuth flow to PKCE" thread; "Review changes against main" (a queued /review against the base branch) and "now squash and push --force-with-lease" stacked as queued chips above the composer'
   caption="The two <strong>QUEUED</strong> chips above the composer will fire FIFO when the in-flight <em>make a branch and PR</em> turn finishes. The composer's <strong>Send</strong> is replaced by <strong>Stop / Queue</strong> while a turn is active."
%}

You don't have to wait for the agent to finish a turn before
queueing the next thing. While a turn is running, the composer's
**Send** stages your message as a **queued turn** instead of
discarding the click — the queued message appears as a chip above
the composer with a small **×** for cancel.

You can queue as many follow-ups as you want, and they dispatch
**FIFO, one turn at a time**. The pattern that earns its keep:

1. Send `make a branch and PR for the OAuth refactor` (turn 1).
2. While that's running, queue `/review` (turn 2).
3. While *that's* queued, queue `now squash and push --force-with-lease`
   (turn 3).

You walk away. By the time you come back, turn 1 has produced a
branch and a PR, turn 2 has run a review pass and addressed
findings, turn 3 has squashed and force-pushed. Slash commands
queue exactly like free-form messages — `/review`, `/status`, and
the rest are first-class queueable.

Queued turns are visible in the composer (chips with cancel `×`)
and in the transcript (a "queued: …" pill on the in-flight turn
showing what's next). Cancel any queued turn by clicking its `×`
in the composer chip — earlier and later queue items keep their
order.

This is the desktop counterpart to the
[messaging queue / steer flow](../using-codex/#debounce-queue-steer);
the two read and write the same per-thread queue, so a turn you
queued from your phone shows up in the desktop's composer chip
list immediately, and vice versa.

### Skills browser ($ autocomplete and chips)

{% include figure.html
   src="/assets/screenshots/desktop-skills-autocomplete.png"
   alt='Composer mid-message ("Let&#39;s use $ce") with the Skills autocomplete listbox open below it, showing matching skill rows like $ce:plan, $ce:brainstorm, $ce:compound'
   caption="Typing <code>$</code> in the composer opens the Skills listbox. Subsequent characters filter incrementally — here <code>$ce</code> narrows to skills whose names start with <code>ce</code>. Pick a row to insert it as an inline chip."
%}

PwrAgent surfaces **Codex skills** (including plugin-exposed
skills) directly in the composer. Type **`$`** and an autocomplete
dropdown opens with every skill the bound Codex profile exposes —
the same `$skill-name` mention syntax Codex itself uses, but with
inline picking and rich tooltips so you don't have to remember
the exact name.

Pick a skill → it lands as an **inline chip** at the cursor (the
chip carries the skill name, a tooltip with the skill's description,
and a small **×** to remove it). The chip expands into the
skill's full mention markdown when the turn is submitted, so the
agent sees `$skill-name` exactly as if you'd typed it.

You can mix skill chips with free-form text in any order: prose,
chip, more prose, another chip. Multiple chips in one message are
each prepended once.

The skill list is shared with the
[messaging Skills browser](../using-codex/#skills-browser) — both
surfaces draw from the same Codex App Server skill registry. Adding
a new plugin-exposed skill makes it appear in `$` autocomplete on
the desktop and in the paged Skills browser on every bound
messenger automatically.

### Search, branch / PR / emoji markers

The sidebar's filter accepts branch names, PR numbers, emoji
markers, and free text. Filtering applies to whichever lens is
active and respects its sort order.

Pin behavior is covered above under [Sidebar lenses → Pins](#sidebar-lenses).

## Multiple profiles

PwrAgent has **two independent profile mechanisms** that compose.
Read once; the rest of the section is a worked setup.

### PwrAgent profiles

A **PwrAgent profile** is selected by the `PWRAGENT_PROFILE` env
var at launch. Each profile carries its own:

- `config.toml` (settings) and `state.db` (session state).
- New-thread sticky settings (the per-thread defaults you've
  carried forward).
- **Messaging profile**, entirely isolated from other PwrAgent
  profiles. One PwrAgent profile can have Telegram + Slack
  configured; another can have just Mattermost; a third can have
  the same Telegram platform but a **different bot token**. They
  don't talk to each other.

Creating a new PwrAgent profile is trivial: pick a name, set the
env var, launch. PwrAgent creates the profile on first run under
`~/.pwragent/profiles/<name>/`.

> **Use case.** Two PwrAgent profiles pointed at the **same Codex
> auth** share the underlying Codex threads, settings, and account
> — but they're independent at the PwrAgent layer. That's how you
> run **multiple bots of the same platform** (e.g. one Telegram bot
> for personal work and another Telegram bot for a small team,
> both driving the same Codex thread list).

### Codex profiles

A **Codex profile** is an isolated `CODEX_HOME` directory the
Codex App Server uses for its own state — auth tokens, thread
history, config. Each Codex profile points at its own OpenAI Codex
identity (or the same identity, if you want).

> **Use case.** Two Codex profiles for a single PwrAgent install:
> `~/.codex/profiles/work/` (your day-job Codex account) and
> `~/.codex/profiles/personal/` (your personal account). Threads
> stay separated; auth stays separated. Switch between them by
> changing the Codex auth profile selection in Settings → Models.

> **Cheekier use case.** Four Codex profiles, each pointed at a
> different Codex Pro account, because you are an animal and need
> four accounts worth of tokens to rule the world. PwrAgent will
> not stop you.

### How the two profile mechanisms compose

| What's isolated | PwrAgent profile | Codex profile |
|---|---|---|
| PwrAgent settings (`config.toml`) | ✅ | — |
| PwrAgent state DB (`state.db`) | ✅ | — |
| Messaging adapters + bot tokens | ✅ | — |
| Codex threads + history | — | ✅ |
| Codex auth (OpenAI account) | — | ✅ |
| Per-thread settings stickiness | ✅ | — |

You can compose them however you want. Examples:

- **1 PwrAgent × 1 Codex.** Default. Single install.
- **2 PwrAgent × 1 Codex.** Two messaging surfaces (different bots
  for the same platform; or one with messaging, one without)
  sharing the same Codex threads.
- **1 PwrAgent × 2 Codex.** One PwrAgent install switching between
  work and personal Codex identities via Settings → Models.
- **N PwrAgent × M Codex.** Whatever combination makes sense.

### Managing profiles in the app

Both kinds of profiles are managed from **Settings → Profiles**:

- **PwrAgent profiles** — list, create new, switch between. Creating
  a profile here gives you a fresh `~/.pwragent/profiles/<name>/`
  with default settings; switching restarts the app under the
  selected profile.
- **Codex auth profiles** — under **Settings → Models → Codex**,
  pick the **Auth profile** dropdown to switch between
  `CODEX_HOME` directories. The dropdown lists the Codex profiles
  PwrAgent finds under `~/.codex/profiles/`. Adding a new Codex
  profile from the same panel triggers the appropriate `codex login`
  flow against the isolated `CODEX_HOME`.

{% include figure.html
   src="/assets/screenshots/settings-profiles.png"
   alt="Settings → Profiles panel listing PwrAgent profiles"
   caption="<strong>Settings → Profiles</strong>. Every PwrAgent profile under <code>~/.pwragent/profiles/</code> is listed; the active one is highlighted. Switching restarts the app under the selected profile."
%}

### Launching a profile from the command line

For automation or when you want to pin a specific PwrAgent profile
at launch:

**Installed `.app` — recommended:**

```bash
open -na PwrAgent --args --profile work
```

The `--profile <name>` argument is the supported launch flag — it
flows through Launch Services into the app's argv, so the app
shows up correctly in the Dock and Cmd-Tab list.

**From source:**

```bash
PWRAGENT_PROFILE=dev pnpm dev:no-messaging
```

The `PWRAGENT_PROFILE` env var still works as a fallback for any
context where passing argv isn't convenient (the dev server and
shell-script launchers being the typical cases).

### Under the hood

The in-app profile management writes to your config file the same
shape an experienced operator would write by hand:

- PwrAgent profile dir: `~/.pwragent/profiles/<name>/` containing
  `config.toml` (settings) and `state/state.db` (session state).
- Codex profile dir: `~/.codex/profiles/<name>/` containing the
  isolated `CODEX_HOME` (auth tokens, thread history, config).
- Selected Codex profile is recorded in the active PwrAgent
  profile's `config.toml`:

  ```toml
  [models.codex]
  profile = "work"
  ```

Verifying without going through the UI:

```bash
# Confirm the active PwrAgent profile selected the right Codex auth
# profile.
rg -n 'profile = "work"|\[models.codex\]' \
  ~/.pwragent/profiles/<your-pwragent-profile>/config.toml

# Once a Codex thread runs under the selected profile, confirm
# Codex state lands in the isolated CODEX_HOME.
find ~/.codex/profiles/work -maxdepth 4 -type f | sort | head -80
```

You should see entries like `auth.json`, `config.toml`,
`session_index.jsonl`, `sessions/`, and (if used) `worktrees/`.

### Mental model

- `--profile <name>` (or `PWRAGENT_PROFILE=<name>`) selects
  PwrAgent's **own** DB, config, and secrets directory.
- The **Codex auth profile** picked inside that PwrAgent profile
  selects which `CODEX_HOME` PwrAgent hands to the Codex App Server.

The two settings live at different layers and don't interact. Pick
each one for its own reason.

## Not yet

Features the desktop **doesn't have today** that operators have
asked about — captured here so you can plan around them:

- **Forking a thread.** No way to branch a thread into two parallel
  paths from a chosen point. If you need to explore an alternative
  while preserving the original, the workaround is to manually
  archive the current state and start a new thread.
- **Restoring archived threads.** Once archived, a thread is gone
  from the active list. The transcript and overlay state are still
  on disk, but there's no UI to surface them. (Roadmap.)
- **Time-based auto-archiving.** Threads stay in the active list
  indefinitely unless you archive them. There's no policy that says
  "archive threads I haven't touched in N days."
- **Branch auto-naming via button click.** Branch names default
  to the worktree hash. There's no button that says "rename this
  branch to something derived from the thread title" yet.

## Coming soon

Active development areas that have shipped designs but aren't in
release builds yet:

- **Environment cleanup on archive or handoff.** The setup side
  shipped with [Codex environments](#codex-environments) — the
  cleanup side (tear down the worktree's working environment when
  a thread is archived or handed back to Local) is still on the
  roadmap. Today nothing cleans up.
- **In-app environment editing.** Environments are usable from
  PwrAgent today, but you author them at the Codex level (not in
  PwrAgent's UI). In-app editing of the environment definition is
  on the roadmap.

Watch the [GitHub repo](https://github.com/pwrdrvr/PwrAgent) for
the relevant PRs.

## See also

- **[Settings](../settings/)** — application discovery, Codex App
  Server / Codex Desktop coordination, worktree storage location.
- **[Messaging](../messaging/)** — drive PwrAgent's threads from
  Telegram, Discord, Slack, Mattermost, Feishu / Lark, or LINE.
- **[Using Codex via Messaging](../using-codex/)** — the end-to-end
  flow for driving a thread from a messenger.
