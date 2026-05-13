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

## Messaging platforms

| Platform | Inbound transport | Outbound limits | Page |
|---|---|---|---|
| Telegram | Long polling | Tightest of the bunch — supergroup writes and edits share one budget | [telegram](messaging/telegram.md) |
| Discord | Gateway WebSocket | Edits permissive, route buckets apply | [discord](messaging/discord.md) |
| Slack | Socket Mode | DM edits permissive; `chat.postMessage` has its own limit | [slack](messaging/slack.md) |
| Feishu / Lark | Persistent SDK WebSocket | Tenant-scoped | [feishu](messaging/feishu.md) |
| Mattermost | HTTP callback (your host) | Server-configured | [mattermost](messaging/mattermost.md) |
| LINE | HTTP webhook (your host) | LINE Bot API limits | [line](messaging/line.md) |

## Read before you toggle

- [Streaming responses: why you probably don't want them](messaging/streaming.md)
- [Webhooks: a security note](messaging/webhook-dangers.md)
- [Messaging concepts overview](messaging/overview.md)

## License

PwrAgent is MIT-licensed, owned by PwrDrvr LLC. See the
[LICENSE](https://github.com/pwrdrvr/PwrAgent/blob/main/LICENSE) and
[THIRD\_PARTY\_LICENSES](https://github.com/pwrdrvr/PwrAgent/blob/main/THIRD_PARTY_LICENSES)
files in the repo.
