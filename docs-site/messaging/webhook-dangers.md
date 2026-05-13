---
layout: page
title: Webhooks — a security note
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

If you're going to operate a webhook, here's a non-exhaustive list of
the work involved:

- A tunnel (Cloudflare, Tailscale, or otherwise) with a stable URL.
- An IP allowlist on the tunnel (where supported) restricted to the
  platform's egress range. For self-hosted Mattermost, the operator's
  IPs. For SaaS, the platform's published egress IPs.
- Cloudflare Access (or equivalent) policies on the public hostname.
- HMAC verification on the inbound payloads — PwrAgent does this, but
  you have to pin the HMAC secret across restarts or buttons rendered
  in the previous session will silently fail.
- Request-size caps to prevent payload-bomb attempts.
- Rate limiting on the tunnel or upstream.
- Logging on the listener with anomaly alerting — fuzzing produces a
  specific traffic pattern you'd want to see early.
- A plan for what to do when you see one — rotate the HMAC, restart the
  adapter, tighten the allowlist.

Most desktop users will not do most of this. Most won't even know to.

## The honest recommendation

If you can use a platform that supports outbound sockets (Telegram,
Discord, Slack, Feishu / Lark), use it. Treat that as the default and
the webhook platforms as the exception.

If you need a webhook platform specifically (you live in LINE, or your
team uses Mattermost), accept the trade-off knowingly. Set up the
tunnel, pin the HMAC, monitor the logs, and budget the time. PwrAgent's
HMAC verification gets you started, but it's not a substitute for the
operational work.

If you read all of the above and you're confident this is easy:
operating a webhook safely is a skill, and you almost certainly have
it. Set it up the way you'd set up any other public service. You don't
need this page.

For everyone else: this page is here so that you know the choice you
made, before you made it.

## See also

- [Mattermost setup](mattermost.md) — Cloudflare Tunnel and Tailscale
  Funnel options, HMAC-secret pinning.
- [LINE setup](line.md) — webhook-only platform, channel-secret
  signature verification.
- [Messaging concepts overview](overview.md).
