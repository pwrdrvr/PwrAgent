# PwrAgent Instance Federation

PwrAgent instance federation lets one profile act as a gateway for other
PwrAgent instances. The first implementation is shaped around a local gateway
listener exposed through a stable Cloudflare Tunnel endpoint, with client
instances connecting back over WebSocket.

## Trust Model

- Cloudflare Tunnel is a reachability and edge-filtering layer. It can restrict
  source IPs, enforce Cloudflare Access, and optionally require Cloudflare-managed
  client certificates before traffic reaches the local gateway port.
- PwrAgent still authenticates peers inside the federation protocol. Each
  instance owns an Ed25519 identity key stored through the desktop secret store.
  Enrollment pins the accepted peer public key, and later handshakes must prove
  possession of the matching private key. The invite also carries the gateway
  public key so a client verifies the gateway's signed challenge before it
  installs the connection.
- Enrollment tokens are one-time bootstrap material. The sqlite store keeps an
  HMAC of the invite token, not the token itself.
- Diagnostics and renderer IPC must not expose private keys, client certificate
  private keys, Cloudflare Access secrets, enrollment tokens, or pinned peer key
  material.

## Modes

- `disabled`: no federation listener or outbound federation connection.
- `gateway`: listens locally and accepts enrolled client peers.
- `client`: connects to the configured gateway URL.
- `dual`: listens as a gateway and can also connect through another gateway.

The current settings contract stores these under `[federation]` in the active
profile config:

- `mode`
- `listen_host`
- `listen_port`
- `public_url`
- `gateway_url`
- `cloudflare_mtls_enabled`
- `cloudflare_access_service_auth_enabled`

Secrets are stored separately under the desktop secret-store names defined by
`DesktopSettingsSecretName`.

## Transport And Routing

The federation transport is a bidirectional WebSocket protocol. Envelopes carry
protocol version, source instance, optional target instance, request IDs, and
deadlines. Gateways may relay envelopes when a client targets another enrolled
instance.

The RPC surface maps navigation and thread reads plus the remote operation
surface used by desktop windows and messaging. It includes thread creation,
fork/review, turn start/steer/interrupt/compact, pending-request submission,
scheduled-action list/create/update/cancel/send-now, model and execution
settings, environment actions, environment setup progress, workspace handoff,
and explicit directory Git-status refreshes. Directory refresh requests carry
owner-known directory keys rather than viewer-resolved paths; the target
instance resolves those keys and runs Git locally. Scheduled operations require
the dedicated `scheduled_actions` capability rather than inheriting broad turn
control. Capability checks remain attached to every method, so an older or
restricted peer fails closed instead of silently executing locally.

Transcript images stay behind the renderer-safe `pwragent-image://` protocol.
For a remote thread, the viewer rewrites owner-local image URLs to identify the
owning instance and lazily fetches the validated bytes with
`backend.readTranscriptImage`. That RPC requires `thread_detail`; the owner
applies the same allowed-root checks as a local file fetch, accepts only signed
PwrSnap media from its fixed loopback origin, and enforces image type and size
limits before returning bytes.

The scheduled-action RPC surface is part of federation protocol v1 while the
protocol remains under development. Peers must authorize `scheduled_actions`
explicitly; `turn_control` does not imply scheduler access.

Navigation snapshot transfer is negotiated independently from navigation
access. A peer that advertises `navigation_snapshot_deltas` may receive a full
baseline followed by revision-based sparse deltas or unchanged responses from
`backend.getNavigationSnapshot`; the request carries the transport protocol
and prior revision. Peers that do not advertise the capability retain the
protocol-v1 full-snapshot contract. Snapshot production remains full on the
owner—the optimization applies at the Federation serialization boundary and
avoids retransmitting and reconstructing unchanged thread rows on the wire.
The owner keeps bounded shared change history per semantic request scope, not
per-peer snapshot state. A revision older than that history receives a new full
baseline, matching list-then-watch recovery semantics.

### Event subscriptions

An authenticated connection does not subscribe a peer to backend events.
Live events use the separately negotiated `event_subscriptions` capability and
replace-style subscriptions scoped by all three of:

- subscriber instance
- owning/source instance
- event class (`navigation`, `transcript`, `pending_requests`,
  `scheduled_actions`, or `star_map`)

Remote workspace windows subscribe to their fixed owning instance for only the
classes supported by that peer. The Star Map subscribes while mounted to
`navigation`, `scheduled_actions`, and `star_map` for its connected visible
instances; it does not request transcript or pending-request traffic.
Messaging subscribes only for instances referenced by active federated
bindings and clears that desired state when messaging stops.

Subscriptions are desired state, not additive commands. Retargeting or closing
a consumer replaces its old set (an empty set is unsubscribe). The subscriber
replays its aggregate desired set after reconnect. A gateway records relayed
subscription routes, forwards events only to the named downstream subscriber,
and removes or replays routes as downstream subscribers or source peers
disconnect and reconnect. Owners likewise clear session-scoped incoming
subscriptions when their authenticated next hop disconnects.

Backend-event envelopes are targeted. Receivers drop an event unless its source
instance and class match local desired state, and they accept a claimed source
different from the authenticated peer only when that peer is their configured
upstream gateway. This keeps one instance's stream out of unrelated local and
remote windows.

Mixed-version behavior is fail-closed on upgraded senders: a peer that does not
advertise `event_subscriptions` receives no live events from a new owner.
Upgraded receivers also discard unsolicited events from older senders. An old
sender can still put legacy broadcast traffic on a connection until it is
upgraded, so the no-unsolicited-network-traffic guarantee requires upgraded
software on the producing side (and on a relaying gateway, when present).

Peer-directory and celestial-icon LWW snapshots remain federation control-plane
state. They exchange when a connection or assignment changes, then settle; they
do not enable or carry the backend-event stream described above.

## Diagnostics

`federation:get-health` returns a sanitized health snapshot for settings and
support tooling. `federation:get-diagnostics` adds bounded, redacted session
audit events:

- configured role and enabled status
- local listener URL when enabled
- public Cloudflare/Tunnel URL when configured
- enrolled peers, including revoked peers, without pinned public key material

UI surfaces should treat this as operator-visible status, not as an authority
for making authorization decisions.

## MVP Dogfood Flow

Build once, then run two isolated profiles from the same checkout:

```sh
pnpm --filter @pwragent/desktop build
PWRAGENT_PROFILE=gateway pnpm --filter @pwragent/desktop preview
PWRAGENT_PROFILE=client pnpm --filter @pwragent/desktop preview
```

In the gateway profile, open Settings -> Federation:

1. Set mode to `gateway`.
2. Keep `listen_host` as `127.0.0.1`.
3. Set a local test port, for example `8765`.
4. Set Public URL to `ws://127.0.0.1:8765` for local testing, or to the
   Cloudflare Tunnel `wss://...` endpoint for remote testing.
5. Save federation settings.
6. Generate an invite.

In the client profile, open Settings -> Federation:

1. Paste the invite into Import invite.
2. Import it. The client switches to `client` mode and stores the gateway URL.
3. Refresh health on both profiles.

Back in the gateway profile:

1. Confirm the client appears under Federation Instances.
2. Click Open next to the client.
3. The new window is scoped to the client instance for thread list, thread read,
   skill list, and prompt submission.

In a client profile:

1. Refresh Settings -> Federation after connecting.
2. Confirm the gateway and any sibling clients appear under Federation
   Instances.
3. Click Open next to the gateway to work against the gateway, or next to a
   sibling client to route through the gateway.

Remote backend events and environment setup progress stream back into the
matching remote window. Remote navigation includes the target instance's
directories and launchpads, so new threads, forks, and reviews execute on the
remote machine as well as operations on existing threads.

See `docs/federation.md` for direct-mode and Cloudflare Tunnel setup, Access
service-token and mTLS credential handling, diagnostics, and revocation.
