---
title: "feat: Federation SSH outer transport and multi-path gateway endpoints"
type: feat
date: 2026-08-04
---

# Federation SSH outer transport and multi-path gateway endpoints

## Summary

Two federation transport enhancements that build on the Noise/Tailscale work
merged in PR #1191:

1. **Noise over SSH.** Accept an `ssh://` endpoint as an outer transport for
   the federation client. SSH replaces the plain WebSocket / Cloudflare /
   Tailscale outer hop only; the mandatory Noise IK encrypted channel and the
   signed, pinned-identity authentication run unchanged inside it.
2. **Multi-path gateway endpoints with ordered fallback.** A client keeps one
   pinned gateway identity (signing key + Noise key in state.db meta) but may
   have several candidate endpoints for reaching it — e.g. LAN `ws://` or
   `ssh://` first, then a Tailscale Serve/Funnel `wss://` URL, then a
   Cloudflare Tunnel `wss://` URL. The reconnect loop tries them in order,
   remembers the last endpoint that worked, and surfaces per-endpoint status.

Operator motivation: the operator runs both a work and a personal tailnet.
The personal tailnet carries PwrAgent, but on the road while attached to the
work tailnet the personal Tailscale Serve URL is unreachable, so the client
must fall back to a Cloudflare Tunnel (or Tailscale Funnel) endpoint without
manual re-configuration — and return to the fast local path when it is
reachable again.

## Product Contract

- The Noise IK layer stays mandatory on every path. There is no endpoint kind
  and no fallback state that connects without the pinned gateway Noise key and
  the pinned Ed25519 gateway identity. This matches the existing contract in
  [docs/federation-connectivity-reference.md](../federation-connectivity-reference.md).
- Endpoint URLs accept exactly three schemes: `ws://`, `wss://`, and the new
  `ssh://[user@]host[:sshPort]` form with an optional
  `?forward=<host>:<port>` query (default `127.0.0.1:47830`) naming the
  gateway machine's loopback listener that sshd should forward to.
- SSH endpoints are dialed with the operator's system OpenSSH client
  (`ssh -W`), so `~/.ssh/config`, agents, keys, and `known_hosts` all apply.
  PwrAgent never stores SSH credentials, never disables host-key checking,
  and runs `BatchMode=yes` so a missing key or unknown host fails closed with
  a readable error instead of hanging on an interactive prompt.
- `[federation] gateway_endpoints` is a new ordered string-array config key.
  When absent, the reader falls back to the existing scalar `gateway_url`.
  Saving endpoints dual-writes the first entry back to `gateway_url` so an
  older build downgraded onto the same profile keeps a working single path.
- The reconnect loop tries the last endpoint that worked first (persisted in
  state.db meta), then the remaining endpoints in configured order. Backoff
  applies per full cycle through the list, not per endpoint, so a short list
  is fully probed before the runtime sleeps.
- Gateways may advertise multiple endpoints in enrollment invites via a new
  `[federation] advertised_endpoints` ordered list (falling back to the
  current single Public URL / listen URL behavior). The invite payload gains
  an optional `gatewayEndpoints` array; the invite version stays 1 because
  older importers ignore the extra field and keep using `gatewayUrl`, and new
  importers treat a missing array as `[gatewayUrl]`.
- Importing an invite seeds both `gateway_endpoints` and `gateway_url`
  (first entry) in config, alongside the existing pinned-identity meta writes.
- Cloudflare Access service-token headers and mTLS client credentials are
  scoped to a single operator-designated host (`[federation]
  cloudflare_endpoint`), compared by host and port. A scheme-only rule was
  tried first and was wrong: these credentials ride the WebSocket upgrade and
  the TLS handshake, both of which complete before the Noise handshake pins
  anything, so "any `wss://` endpoint" would hand the Access bearer token and
  the mTLS client key to every TLS host in the fallback list. With no endpoint
  designated they apply only to a single-endpoint configuration, which
  preserves pre-multi-path behavior without widening it.
- Settings → Federation:
  - The Configuration section replaces the single "Gateway URL" input with a
    "Gateway endpoints" ordered editor (one endpoint per line, first line is
    tried first). Save still round-trips through the existing
    `writeSettingsConfig` patch path.
  - The Connection card lists every configured endpoint with its own status
    (Active / Connecting / Failed / Idle), the last error for failed
    endpoints, and marks the endpoint the current session is using.
- Diagnostics audit entries for connection attempts and failures include the
  endpoint being tried (redacted through the existing
  `redactFederationDiagnostic` path).

## Architecture

### SSH dialer (`apps/desktop/src/main/federation/federation-ssh.ts`, new)

- `parseFederationSshEndpoint(url)` → `{ user?, host, sshPort?, forwardHost,
  forwardPort }`, rejecting anything with credentials-in-URL (`ssh://a:b@…`),
  empty host, or a non-numeric port/forward.
- `dialFederationSshEndpoint(endpoint, { spawn? })` spawns
  `ssh -o BatchMode=yes -o ConnectTimeout=10 [-p sshPort] -W
  forwardHost:forwardPort [user@]host`, wraps the child's stdio in a Duplex
  stream, and resolves once the child is running. Returns
  `{ socket, close() }`; killing/closing either side tears down the other.
  stderr is captured (bounded) so auth/host-key failures produce a readable
  error. The spawn function is injectable for tests.
- Invokes `ssh` from `PATH`. A Windows System32 OpenSSH fallback mirroring
  `federation-tailscale.ts` was considered and deferred; it is noted as a
  limitation in the connectivity reference rather than silently assumed.

### Transport (`federation-transport.ts`)

- `connectFederationClient` gains an optional `createSocket?: () => Duplex`
  (plus internal cleanup on close). When present, the WebSocket is
  constructed with a one-shot `http.Agent` whose `createConnection` returns
  that stream, and the `url` passed to `new WebSocket(...)` is the inner
  `ws://forwardHost:forwardPort` target so the upgrade `Host` header matches
  the gateway listener. Everything after socket open — transport hello, Noise
  IK handshake, channel-bound signed auth, envelope streaming — is unchanged.
- No gateway-side transport change: sshd terminates SSH and forwards a plain
  TCP connection to the loopback WebSocket listener, exactly like the manual
  reverse-tunnel topology already described in the connectivity reference.

### Config (`packages/shared/src/contracts/settings.ts`, `desktop-config.ts`,
`desktop-settings-service.ts`)

- `DesktopSettingsConfigPatch.federation` gains `gatewayEndpoints?: string[]`
  and `advertisedEndpoints?: string[]`; `DesktopFederationSettingsSnapshot`
  gains the matching `DesktopSettingsValue<string[]>` entries.
- Reader: `gateway_endpoints` via the existing `readStringArray`, no eager
  rewrite. Writer: empty array deletes the key; non-empty writes the array
  and dual-writes `gateway_url` to the first entry. `advertised_endpoints`
  follows the same pattern (no legacy scalar to dual-write).
- Snapshot resolution: `gatewayEndpoints.value` =
  `config.gatewayEndpoints ?? (gatewayUrl ? [gatewayUrl] : [])`, so every
  consumer sees one ordered list regardless of config vintage.

### Runtime (`federation-runtime.ts`)

- New meta key `federation_gateway_last_endpoint` beside the existing
  `GATEWAY_*` keys.
- `connectClient(gatewayUrl)` becomes `connectToGateway(endpoints: string[])`:
  - Attempt order = pure helper `orderFederationEndpointAttempts(endpoints,
    lastGood)` (last-good first when still configured, then config order).
  - Endpoints are tried sequentially; the first success records last-good
    meta and per-endpoint `active` status. Failures record per-endpoint
    `failed` status with a redacted error and fall through to the next.
  - When the whole cycle fails, the existing exponential backoff
    (`scheduleReconnect`) applies to the next full cycle.
  - `ssh://` endpoints resolve through the SSH dialer; `ws://`/`wss://` keep
    the direct path. Cloudflare header/mTLS options are only attached for
    `wss://` endpoints.
- Per-endpoint status lives in runtime memory
  (`Map<url, FederationEndpointStatus>`) and is rebuilt on restart; `health()`
  emits it in config order as `health.gatewayEndpoints`.
- `generateInvite` builds the invite endpoint list from
  `advertisedEndpoints`, falling back to `[publicUrl || listenUrl]`.
  `importInvite` writes `gatewayEndpoints` + `gatewayUrl` and keeps the
  existing pinned-identity meta writes.

### Shared federation contract (`packages/shared/src/contracts/federation.ts`)

- `FederationEndpointState` (`"active" | "connecting" | "failed" | "idle"`)
  and `FederationEndpointStatus { url, state, lastAttemptAt?,
  lastConnectedAt?, lastError? }`.
- `FederationHealthStatus.gatewayEndpoints?: FederationEndpointStatus[]`.

### Enrollment (`federation-enrollment.ts`)

- `FederationInvitePayload.gatewayEndpoints?: string[]` — optional; decode
  enforces the same endpoint rules as every other entry point (scheme
  allowlist, no embedded password, no leading-dash host/user), since an invite
  is unsigned and bypasses the Settings UI. `importInvite` returns the list it
  applied.

### Settings UI (`FederationSettings.tsx`)

- Configuration: "Gateway endpoints" and "Advertised endpoints" textareas, one
  per line, ordered; validated against the scheme allowlist before save.
  Renderer validation is UX only — the main process re-validates, since the
  config file is hand-editable and invites never pass through the UI.
- Cloudflare: a "Cloudflare endpoint" field designating the single
  Cloudflare-fronted host that may receive Access tokens and client
  certificates.
- Connection: per-endpoint rows showing URL, status label, active marker,
  last error, and last connected time; retains the existing single
  listener/public URL fields.

## Security Review

The core invariant: **endpoint selection is reachability only; identity and
confidentiality are pinned per gateway, not per endpoint.**

- Every endpoint, on every fallback attempt, runs the identical
  `connectFederationClient` flow: transport-hello check, Noise IK handshake
  against the pinned gateway Noise static key, and Ed25519
  challenge/accept verification against the pinned gateway signing key, with
  the client's signed proof bound to the Noise handshake hash. An
  attacker-controlled endpoint (malicious DNS, hijacked tunnel hostname,
  hostile LAN listener, compromised SSH bastion) cannot complete Noise
  message 2 without the gateway's Noise private key, so the connection fails
  before any federation payload is sent. Fallback therefore cannot redirect a
  client to a different gateway identity — it can only cause that endpoint to
  fail and the loop to move on (bounded DoS, which the attacker on that path
  already had).
- There is no downgrade state: client mode requires the pinned Noise key
  (`connectFederationClient` throws without it) and there is deliberately no
  setting to disable Noise. `ssh://` endpoints add SSH on the outside but
  change nothing inside.
- No endpoint is ever learned from network traffic: the gateway cannot push
  endpoint changes to enrolled clients, and `federation_gateway_last_endpoint`
  only ever holds a value copied from the configured list after a fully
  authenticated session was established on it.
- An imported invite is **not** trusted input just because it carries pinned
  keys. It is unsigned, operator-pasteable, and never passes through the
  Settings UI, so its endpoints are validated on decode against the same
  scheme allowlist (and the no-password / no-leading-dash rules), and the
  imported list is returned to the caller so the operator can see what a
  pasted invite configured.
- **Outer edge credentials are not covered by the pinned keys.** Cloudflare
  Access service tokens and mTLS client certificates travel in the WebSocket
  upgrade and the TLS handshake, both of which complete before the Noise
  handshake verifies anything. They are therefore scoped to a single
  operator-designated host (`cloudflare_endpoint`), matched on host and port;
  with none designated they apply only to a single-endpoint configuration.
  Anything looser — including a `wss://`-only rule — sends the bearer token
  and client key to every TLS endpoint the fallback walks, which for an
  invite-supplied endpoint is a credential-theft primitive.
- `ssh://` endpoints may only forward to the gateway's loopback address, so an
  endpoint cannot use the operator's SSH server to reach other hosts on its
  network. Hosts and users beginning with `-` are rejected so nothing reaches
  `ssh` in option position.
- Availability is part of the security posture here: the whole pre-session
  exchange is bounded by a deadline, because an endpoint that accepts the
  upgrade and then goes silent would otherwise stall the endpoint walk, the
  reconnect loop, and (through `restart()`) the Settings write IPC.
- SSH host-key verification remains OpenSSH's job with its normal strictness;
  PwrAgent never sets `StrictHostKeyChecking=no`. Even a spoofed SSH host
  only reaches the Noise pin failure described above.
- Failure detail crossing the process boundary continues to flow through
  `redactFederationDiagnostic`.

## Verification

- [x] `federation-ssh` tests: endpoint parsing (user/host/port/forward,
  rejection of embedded passwords and bad schemes), spawn argument shape,
  dial + teardown against an injected fake spawn.
- [x] `federation-transport` test: full Noise handshake + envelope round-trip
  over a `createSocket` stream (net socketpair to the listener), proving the
  SSH path carries the encrypted channel unchanged.
- [x] Endpoint-ordering helper tests: last-good-first, last-good removed from
  config, empty list.
- [x] Runtime tests: fallback walks endpoints in order and connects on a later
  endpoint after earlier failures; per-endpoint statuses and last-good meta
  update.
- [x] Credential-scoping tests: the designated host receives Access headers and
  the client certificate; a different `wss://` host in the same list does not;
  a multi-endpoint config with no designation withholds from all; a
  single-endpoint config still works; `ws://` and `ssh://` never receive them.
- [x] Shared parser tests: scheme allowlist, embedded-password and
  leading-dash rejection, case/port normalization, IPv6 hosts.
- [x] Transport test: a peer that upgrades and then goes silent fails on the
  connect deadline instead of hanging the endpoint walk.
- [x] SSH transport test: the real `SshStdioSocket` under a real WebSocket
  upgrade completes the Noise handshake, streams envelopes, and closes without
  raising an uncaught error. (The unit and transport tests each covered one
  half of this; the gap is what hid the child-exit defect.)
- [x] Config tests: `gateway_endpoints` read, `gateway_url` fallback, canonical
  shape only on fresh configs, legacy marker comment on an existing
  `gateway_url`, preserved legacy scalar when the list is cleared, and
  unsupported schemes dropped on read.
- [x] Enrollment tests: invite encode/decode with and without
  `gatewayEndpoints`; import seeds config list.
- [x] `FederationSettings` tests: endpoints editor renders/saves ordered list;
  Connection card renders per-endpoint status.
- [x] `pnpm typecheck`, `pnpm lint:eslint`, `pnpm lint:boundaries` pass.
- [x] [docs/federation-connectivity-reference.md](../federation-connectivity-reference.md)
  updated: PwrAgent-managed SSH outer transport and multi-path endpoint
  fallback sections.
