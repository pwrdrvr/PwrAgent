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

The **Public port?** column says whether PwrAgent has to expose an
HTTP listener to the internet. **✅ No** = PwrAgent dials out, nothing
on your machine accepts incoming traffic. **❌ Yes** = the platform
dials in to a callback URL you host, usually fronted by Cloudflare
Tunnel or Tailscale Funnel — read
[Webhooks — a security note](../webhook-dangers/) before standing
one up.

Click the platform name to jump straight to its setup page.

| Platform | Inbound transport | Public port? | Notes | Setup |
|---|---|---|---|---|
| **[Telegram](telegram/)** | Long polling | ✅ No | Tightest write budget; bot token is the only credential needed | [telegram](telegram/) |
| **[Discord](discord/)** | Gateway WebSocket | ✅ No | Requires Message Content Intent + Application ID | [discord](discord/) |
| **[Slack](slack/)** | Socket Mode | ✅ No | Enable Socket Mode before Event Subscriptions | [slack](slack/) |
| **[Feishu / Lark](feishu/)** | Persistent SDK WebSocket | ✅ No | Default persistent connection; publish a version to apply scopes | [feishu](feishu/) |
| **[Mattermost](mattermost/)** | HTTP callback (your host) | ❌ Yes | Tunneled webhook for button clicks; pin the HMAC secret | [mattermost](mattermost/) |
| **[LINE](line/)** | HTTP webhook (your host) | ❌ Yes | Webhook-only; no outbound-socket option | [line](line/) |

For the security tradeoffs of HTTP-callback platforms (Mattermost, LINE)
vs. outbound-socket platforms (Telegram, Discord, Slack, Feishu),
see [Webhooks — a security note](../webhook-dangers/).
