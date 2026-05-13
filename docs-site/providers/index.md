---
layout: page
title: Providers
permalink: /providers/
---

# Messaging providers

PwrAgent supports six messaging platforms. The Settings → Messaging
panel in the desktop app pairs each one through a "What you need to
get started" → "Step by step" → "Settings reference" flow.

Each page below covers the platform's setup and the per-field
behavior in the Settings panel. For how to *use* a paired bot once
it's connected — bound threads, slash commands, the resume browser,
debounce / queue / steer, monitor cards, detach — see
[Using Codex via Messaging](../using-codex/).

| Platform | Inbound transport | Notes | Setup |
|---|---|---|---|
| Telegram | Long polling | Tightest write budget; bot token is the only credential needed | [telegram](telegram/) |
| Discord | Gateway WebSocket | Requires Message Content Intent + Application ID | [discord](discord/) |
| Slack | Socket Mode | Enable Socket Mode before Event Subscriptions | [slack](slack/) |
| Mattermost | HTTP callback (your host) | Tunneled webhook for button clicks; pin the HMAC secret | [mattermost](mattermost/) |
| Feishu / Lark | Persistent SDK WebSocket | Default persistent connection; publish a version to apply scopes | [feishu](feishu/) |
| LINE | HTTP webhook (your host) | Webhook-only; no outbound-socket option | [line](line/) |

For the security tradeoffs of HTTP-callback platforms (Mattermost, LINE)
vs. outbound-socket platforms (Telegram, Discord, Slack, Feishu),
see [Webhooks — a security note](../webhook-dangers/).
