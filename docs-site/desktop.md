---
layout: page
title: Desktop
permalink: /desktop/
---

# The PwrAgent desktop

PwrAgent is an Electron desktop app. It runs locally, stores its
state under `~/.pwragent/`, and pairs a Codex thread list with a
thread-detail view, a composer, and a sidebar of recents. There's no
cloud relay and no PwrAgent-owned account — see
[Settings](../settings/) for how the desktop discovers your local
Codex install and how authentication works.

The rest of this page covers what the desktop **does**, what's not in
it yet, and what's coming soon.

## What's in the desktop today

### Recents lens

The default browsing surface is the **Recents lens** in the left
sidebar — a single scrollable list of your recent threads. User-
curated **Pins** live as a scrollable section at the top of the same
list. The other lens you can switch to is **Directories**.

Unread state on a thread shows as an orange cookie marker on the
row, not a punctuation badge.

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

Worktree storage location is configurable — see
[Settings → Worktrees](../settings/#worktrees).

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

- Triple backticks + space opens a code block.
- `>` + space opens a blockquote.
- Standard inline formatting (`**bold**`, `*italic*`, `` `code` ``,
  links) renders as you type.

Codex Desktop doesn't have this yet.

### Search, pins, branch / PR / emoji markers

The sidebar's filter accepts branch names, PR numbers, emoji
markers, and free text. Pin threads you want to keep at the top of
Recents; the pinned section is scrollable independently of the rest
of the list.

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
- **Tight auto-archiving.** Threads stay in Recents indefinitely
  unless you archive them. There's no policy that says "archive
  threads I haven't touched in N days."
- **Branch auto-naming via button click.** Branch names default
  to the worktree hash. There's no button that says "rename this
  branch to something derived from the thread title" yet.

## Coming soon

Active development areas that have shipped designs but aren't in
release builds yet:

- **Environment setup on new worktree.** When PwrAgent creates a
  worktree, it'll optionally run a configurable setup hook (install
  deps, run codegen, warm caches) before handing the worktree to
  the agent. Today you have to do this manually.
- **Environment cleanup on archive or handoff.** Inverse of the
  above — tear down the worktree's working environment when a
  thread is archived or handed back to Local. Today nothing
  cleans up.

If either of these would be load-bearing for your workflow, watch
the [GitHub repo](https://github.com/pwrdrvr/PwrAgent) for the
relevant PRs.

## See also

- **[Settings](../settings/)** — application discovery, Codex App
  Server / Codex Desktop coordination, worktree storage location.
- **[Messaging](../messaging/)** — drive PwrAgent's threads from
  Telegram, Discord, Slack, Mattermost, Feishu / Lark, or LINE.
- **[Using Codex via Messaging](../using-codex/)** — the end-to-end
  flow for driving a thread from a messenger.
