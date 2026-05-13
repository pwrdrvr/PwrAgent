---
layout: home
title: PwrAgent docs
---

<div class="wordmark-hero">
  <div class="wordmark-hero__mark">Pwr<span class="wordmark-hero__accent">Agent</span></div>
  <div class="wordmark-hero__tagline">threads / transcripts</div>
</div>

# PwrAgent

PwrAgent is a beta desktop coding agent that you drive from the chat
platforms you already use. Start a thread on your laptop, refine the
requirements with it from Slack, approve a Default-Access command from
Telegram, and pick the thread back up on the desktop when you sit down
again.

This site is the **operator's guide** — setup, settings, and the
tradeoffs behind each toggle. For the codebase, the architecture, and
the contributor's path, head to the
[GitHub repo](https://github.com/pwrdrvr/PwrAgent).

## Get started

- **Download** the latest signed macOS build from the
  [GitHub Releases page](https://github.com/pwrdrvr/PwrAgent/releases).
- **Install** by opening the DMG and dragging PwrAgent into Applications.
- **Pair a messenger** from **Settings → Messaging**. Pick your platform
  below for the exact flow.

## Using Codex from your messenger

Once you've paired a messenger, the **bound-thread, slash commands,
buttons, queue-and-steer, monitor card, detach** flow is mostly the
same across every provider. The [Using Codex via Messaging](using-codex/)
guide walks through it end to end, with per-provider exceptions
called out inline.

## Messaging platforms

The **Public port?** column says whether PwrAgent has to expose an
HTTP listener to the internet for that platform to deliver events to
it. Platforms with **✅ No** use a PwrAgent-initiated outbound
connection — nothing on your machine accepts incoming traffic.
Platforms with **❌ Yes** require a publicly reachable callback URL,
usually fronted by Cloudflare Tunnel or Tailscale Funnel. See
[Webhooks — a security note](webhook-dangers/) before standing one up.

| Platform | Inbound transport | Public port? | Outbound limits | Setup |
|---|---|---|---|---|
| Telegram | Long polling | ✅ No | Tightest of the bunch — supergroup writes and edits share one budget | [telegram](providers/telegram/) |
| Discord | Gateway WebSocket | ✅ No | Edits permissive, route buckets apply | [discord](providers/discord/) |
| Slack | Socket Mode | ✅ No | DM edits permissive; `chat.postMessage` has its own limit | [slack](providers/slack/) |
| Feishu / Lark | Persistent SDK WebSocket | ✅ No | Tenant-scoped | [feishu](providers/feishu/) |
| Mattermost | HTTP callback (your host) | ❌ Yes | Server-configured | [mattermost](providers/mattermost/) |
| LINE | HTTP webhook (your host) | ❌ Yes | LINE Bot API limits | [line](providers/line/) |

## Read before you toggle

- [Using Codex via Messaging](using-codex/) — the end-to-end usage guide
- [Streaming responses: why you probably don't want them](streaming/)
- [Webhooks: a security note](webhook-dangers/)
- [Rate limits and budgets](rate-limits/) — per-platform measured write budgets

## License

PwrAgent is MIT-licensed, owned by PwrDrvr LLC. See the
[LICENSE](https://github.com/pwrdrvr/PwrAgent/blob/main/LICENSE) and
[THIRD\_PARTY\_LICENSES](https://github.com/pwrdrvr/PwrAgent/blob/main/THIRD_PARTY_LICENSES)
files in the repo.
