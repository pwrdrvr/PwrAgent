---
layout: page
title: Messaging
permalink: /messaging/
---

# Messaging

PwrAgent's messaging surface lets you drive Codex threads from the
chat platforms you already use — Telegram, Discord, Slack,
Mattermost, Feishu / Lark, LINE. Everything below is operator-facing;
the contributor / architecture content lives in the main repo under
`docs/messaging-*.md`.

## Where to start

If you're new to PwrAgent's messaging story, the recommended path is
**Using Codex via Messaging → Providers**:

1. **[Using Codex via Messaging](../using-codex/)** — the end-to-end
   usage guide. Bound threads, slash commands, the resume browser,
   the start card, debounce / queue / steer, monitor cards, detach.
   Same across every provider; per-provider quirks called out
   inline.
2. **[Providers](../providers/)** — per-platform setup walkthroughs.
   "What you need to get started" → "Step by step" → "Settings
   reference" for each of the six platforms.

## Setting up providers

Pick your platform. Setup pages each follow the same structure
(credentials needed → exact paste/save/test/pair flow → field-by-
field Settings reference). Click the platform name to jump
straight to its setup page.

| Platform | Inbound transport | Public port? | Setup |
|---|---|---|---|
| **[Telegram](../providers/telegram/)** | Long polling | ✅ No | [telegram](../providers/telegram/) |
| **[Discord](../providers/discord/)** | Gateway WebSocket | ✅ No | [discord](../providers/discord/) |
| **[Slack](../providers/slack/)** | Socket Mode | ✅ No | [slack](../providers/slack/) |
| **[Feishu / Lark](../providers/feishu/)** | Persistent SDK WebSocket | ✅ No | [feishu](../providers/feishu/) |
| **[Mattermost](../providers/mattermost/)** | HTTP callback (your host) | ❌ Yes | [mattermost](../providers/mattermost/) |
| **[LINE](../providers/line/)** | HTTP webhook (your host) | ❌ Yes | [line](../providers/line/) |

✅ No = PwrAgent dials out to the platform; nothing on your machine
accepts incoming public traffic. ✅ is the safer default.

❌ Yes = the platform dials into a callback URL you host, usually
fronted by Cloudflare Tunnel or Tailscale Funnel. Read
[Webhooks — a security note](../webhook-dangers/) before standing
one up.

## Pairing

The **Pairing** flow is how you populate every platform's
authorized-user list (and shared-space allowlists) without having
to find a numeric platform ID anywhere. Same mechanic across all
six providers; the captured walkthrough plus the Messaging Activity
troubleshooting screen for blocked inbound messages live at
[Messaging → Pairing](pairing/).

## Read before you toggle

A handful of cross-cutting reference pages worth reading once before
configuring anything:

- **[Streaming responses](../streaming/)** — why the toggle is off
  by default and why turning it on usually makes things worse, not
  better.
- **[Webhooks — a security note](../webhook-dangers/)** — what's at
  stake for the two HTTP-callback platforms (Mattermost, LINE),
  what you need to do at the tunnel layer, and when Mattermost can
  stay on a private network.
- **[Rate limits and budgets](../rate-limits/)** — per-platform
  write budgets from May 2026 PwrAgent probes, Slow Mode and Cool
  Off priority order, per-platform label caps.

## See also

- **[Desktop](../desktop/)** — the PwrAgent desktop app itself
  (features, worktrees, per-thread settings).
- **[Settings](../settings/)** — non-messaging settings: terminal /
  editor / git / `gh` discovery, Codex App Server / Codex Desktop
  coordination, worktree storage location.
