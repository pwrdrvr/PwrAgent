# PwrAgent Instance Federation

PwrAgent instance federation lets one profile act as a gateway for other
PwrAgent instances. The first implementation is shaped around a local gateway
listener exposed through a stable Cloudflare Tunnel endpoint, with child
instances connecting back over WebSocket.

## Trust Model

- Cloudflare Tunnel is a reachability and edge-filtering layer. It can restrict
  source IPs, enforce Cloudflare Access, and optionally require Cloudflare-managed
  client certificates before traffic reaches the local gateway port.
- PwrAgent still authenticates peers inside the federation protocol. Each
  instance owns an Ed25519 identity key stored through the desktop secret store.
  Enrollment pins the accepted peer public key, and later handshakes must prove
  possession of the matching private key.
- Enrollment tokens are one-time bootstrap material. The sqlite store keeps an
  HMAC of the invite token, not the token itself.
- Diagnostics and renderer IPC must not expose private keys, client certificate
  private keys, Cloudflare Access secrets, enrollment tokens, or pinned peer key
  material.

## Modes

- `disabled`: no federation listener or outbound federation connection.
- `gateway`: listens locally and accepts enrolled child peers.
- `child`: connects to the configured gateway URL.
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
deadlines. Gateways may relay envelopes when a child targets another enrolled
instance.

The first RPC surface intentionally maps read-oriented backend operations:

- `backend.listThreads`
- `backend.readThread`
- `backend.listSkills`

This is enough to bootstrap remote windows, thread discovery, and federated
search without prematurely exposing turn-control or environment mutation.

## Diagnostics

`federation:get-health` returns a sanitized health snapshot for settings and
future support tooling:

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
PWRAGENT_PROFILE=master pnpm --filter @pwragent/desktop preview
PWRAGENT_PROFILE=child pnpm --filter @pwragent/desktop preview
```

In the master profile, open Settings -> Federation:

1. Set mode to `gateway`.
2. Keep `listen_host` as `127.0.0.1`.
3. Set a local test port, for example `8765`.
4. Set Public URL to `ws://127.0.0.1:8765` for local testing, or to the
   Cloudflare Tunnel `wss://...` endpoint for remote testing.
5. Save federation settings.
6. Generate an invite.

In the child profile, open Settings -> Federation:

1. Paste the invite into Import invite.
2. Import it. The child switches to `child` mode and stores the gateway URL.
3. Refresh health on both profiles.

Back in the master profile:

1. Confirm the child appears under Federation Instances.
2. Click Open next to the child.
3. The new window is scoped to the child instance for thread list, thread read,
   skill list, and prompt submission.

In a child profile:

1. Refresh Settings -> Federation after connecting.
2. Confirm the gateway and any sibling children appear under Federation
   Instances.
3. Click Open next to the gateway to work against the master, or next to a
   sibling child to route through the gateway.

Remote backend events stream back into the matching remote window, so prompt
submission should show live turn status, tool activity, and assistant deltas
without reopening the thread. The MVP still expects you to test against an
existing child thread; remote new-thread creation is not wired yet.
