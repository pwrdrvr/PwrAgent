---
layout: page
title: Webhooks — a security note
redirect_from:
  - /messaging/webhook-dangers/
  - /messaging/webhook-dangers
---

# Webhooks: a security note

Some messaging platforms require a **webhook** — a publicly reachable
HTTP endpoint that the platform's servers POST callbacks to. The
platform dials in to your machine; your machine accepts the request.

Other platforms support an **outbound socket** — a long-running
connection that PwrAgent dials out to the platform. The connection
carries both inbound events and your responses. Nothing on your
machine accepts incoming traffic from the internet.

The two postures look similar on paper. Operationally and from a
security standpoint, they are not.

## The short version

| Platform | Supports outbound socket? | Requires webhook? |
|---|---|---|
| Telegram | Yes (long polling) | No |
| Discord | Yes (Gateway WebSocket) | No |
| Slack | Yes (Socket Mode) | No |
| Feishu / Lark | Yes (persistent SDK WebSocket, default) | No |
| Mattermost | No | **Yes** (HTTP callback for button clicks) |
| LINE | No | **Yes** (HTTP webhook for inbound events) |

If you have a choice, prefer the outbound socket. The non-webhook path
is materially safer for the typical desktop user.

## Why the outbound socket is safer

When PwrAgent dials out, your machine is the one initiating the
connection. No port is open to the public internet. Nothing on your
network is a target for unsolicited traffic.

When a webhook is exposed, your machine is **accepting** traffic from
the internet — directly, or through a tunnel like Cloudflare Tunnel or
Tailscale Funnel. From the attacker's point of view, an HTTP listener
is an HTTP listener. The fact that it's tunneled doesn't change what
arrives at the listener's HTTP-parsing layer.

That listener becomes a target for:

- **DDoS / DoS:** flood traffic exhausts the listener, the tunnel, or
  the host's resources. Your agent goes unresponsive even though
  nothing is technically "exploited."
- **Fuzzing attacks:** automated tooling sweeping public endpoints
  with malformed inputs looking for crashes, hangs, or memory-corruption
  bugs in HTTP-parsing layers. Every dependency in the platform's SDK
  is in scope.
- **Payload-based exploits:** if any library in the inbound path —
  the HTTP server, the JSON parser, an upload handler, a logger that
  prints user data — has an exploitable bug, the public listener is
  how that bug is reached. Coding-agent runtimes have broad surface area
  for this.
- **Information leakage:** verbose error pages, stack traces, or
  health endpoints that get added "just for debugging" can fingerprint
  your installation in ways that help a future attacker.

## Cloudflare Tunnel and Tailscale Funnel don't make this safe

They make it **less bad**. They're not a fix.

A tunnel terminates TLS at the cloud provider's edge and forwards
unencrypted traffic to a daemon on your machine. The traffic still
arrives at your HTTP listener. The daemon doesn't inspect the request
contents, doesn't rate-limit per-endpoint, and doesn't do payload
sanitization. The platform's IP allowlists (where supported) reduce
the spray, but they don't eliminate it — any traffic from the
allowlisted range can still hit your listener.

The tunnel also doesn't free you from monitoring. Without observability
on the request stream, you won't see fuzzing happen until something
breaks.

## What "running a webhook safely" looks like

Treat the tunnel — Cloudflare, Tailscale, or whatever you're using —
as the primary line of defense, not PwrAgent. The hardening work
lives at the tunnel layer because that's where the public traffic
actually arrives. A non-exhaustive list of what's involved:

- A tunnel with a stable public hostname.
- **Source-IP allowlisting at the tunnel layer**, restricted to the
  messaging platform's outbound egress range (for self-hosted
  Mattermost, your own IPs; for SaaS-hosted platforms, the platform's
  published egress range).
- **Request signature verification at the tunnel layer.** Every
  webhook-using messaging platform signs its callbacks with a
  per-app secret. The right place to verify those signatures is
  **at the tunnel** (a Cloudflare Worker, a Tailscale Funnel-side
  middleware, a reverse proxy with a Lua/WASM check, etc.) so
  unsigned or forged traffic is rejected before it ever reaches the
  agent. The exact mechanism varies by **both** the messaging
  platform **and** the tunneling provider; **figuring out how to
  wire it up for your specific combination is beyond the scope of
  this guide** and is left to the reader.
- Cloudflare Access (or equivalent identity-aware proxy) on the
  public hostname.
- Request-size caps and rate limits on the tunnel.
- Anomaly alerting on the request stream — fuzzing produces a
  specific traffic pattern you'd want to see early.
- A plan for what to do when you do see one.

Most desktop users will not do most of this. Most won't even know to.
**This is the operational reason we don't recommend webhook-only
platforms.** The work is real, platform-and-tunnel-specific, and
getting it wrong has a real attack surface — none of which PwrAgent
can do on your behalf.

## The honest recommendation

If you can use a platform that supports outbound sockets (Telegram,
Discord, Slack, Feishu / Lark), use it. Treat that as the default
and the webhook platforms as the exception.

The two webhook-required platforms split very differently:

### Mattermost — depends on whose server it is

If the Mattermost server you're connecting to is **yours** — running
on the same machine as PwrAgent, on your home LAN, or on a private
VPC you operate — the webhook callback path can stay on that private
network. The Mattermost server can dial the bot's local listener at
`127.0.0.1` (or its LAN-private equivalent) directly; no public
tunnel, no public hostname, no public attack surface. In that
posture Mattermost is functionally equivalent to the outbound-socket
platforms and the rest of this page doesn't apply.

If the Mattermost server is **someone else's** SaaS-hosted instance,
or otherwise lives outside your private network, then the same
public-tunnel work the rest of this page describes applies in full.

### LINE — always public

LINE doesn't give you that choice. LINE's servers live on the public
internet and have to be able to reach your webhook over the public
internet. There is no private-network mode and no equivalent of
"point LINE at 127.0.0.1." If you use LINE, you **must** stand up a
public tunnel and do the operational hardening yourself. There is
no shortcut.

This is why LINE is the platform we'd most steer people away from
unless they specifically need it.

## If this is easy for you

Operating a public webhook safely is a skill, and if you've shipped
one before you almost certainly have it. Set it up the way you'd set
up any other public service. You don't need this page.

For everyone else: this page is here so that you know the choice you
made, before you made it.

## See also

- [Mattermost setup](providers/mattermost/) — tunnel options for the
  public-server case and the connection-test flow.
- [LINE setup](providers/line/) — webhook-only platform.
- [Using Codex via Messaging](/using-codex/).
