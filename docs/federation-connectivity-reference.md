# Federation Connectivity and Security Reference

This document is source material for user-facing PwrAgent documentation. It
explains the available ways to connect PwrAgent instances, which component
encrypts each part of the path, where unwanted traffic is rejected, and which
security boundary remains authoritative.

Federation is disabled by default. An operator explicitly enables a gateway,
enrolls each client with a short-lived invite, and can revoke an enrolled peer.

## The Three Independent Questions

Every federation setup needs clear answers to three different questions:

1. **Reachability:** How does the client reach the gateway?
2. **Transport protection:** What prevents an observer from reading or changing
   messages while they cross the network?
3. **PwrAgent identity:** How does the gateway know that the caller is an
   enrolled PwrAgent instance, and how does the client know it reached the
   intended gateway?

A tunnel or VPN answers the first two questions. It does not replace PwrAgent's
own enrollment and signed peer authentication. Conversely, application-level
peer authentication does not by itself make a plain `ws://` network path
confidential.

## Connection Options at a Glance

| Option | Exposure | Network encryption | Outer admission gate | PwrAgent peer authentication | Intended use |
|---|---|---|---|---|---|
| Loopback `ws://` | Same machine only | Not needed across a network | Operating-system loopback | Required | Two isolated profiles on one machine |
| Direct LAN `ws://` | LAN interface | None | Host firewall only | Required | Avoid unless an encrypted overlay is protecting the path |
| SSH reverse tunnel | SSH endpoint | SSH | SSH key and server access | Required | Development, temporary administration, and VM labs |
| PwrAgent encrypted transport | Configured listener | PwrAgent secure channel | PwrAgent enrollment | Required and channel-bound | Direct LAN or other private routed networks |
| Tailscale Serve | Tailnet only | Tailscale/WireGuard plus HTTPS | Tailnet identity and grants | Required | Private access among the operator's enrolled devices |
| Tailscale Funnel | Public hostname | HTTPS plus encrypted Tailscale relay | Public by default | Required | Public reachability when Cloudflare is not desired |
| Cloudflare Tunnel | Public hostname | TLS plus encrypted tunnel | Optional Access, mTLS, WAF, or IP policy | Required | Stable Internet reachability without an inbound home-network port |

The safest default for a public hostname is to use both an edge admission gate
and PwrAgent peer authentication. The safest private-network option is an
authenticated private overlay such as Tailscale Serve, with PwrAgent peer
authentication still enabled.

## PwrAgent Enrollment and Peer Authentication

Each PwrAgent profile owns an Ed25519 identity key stored through encrypted
desktop secret storage. A gateway invite contains the information a client
needs to reach and authenticate the intended gateway. Enrollment is short-lived
and single-use. The gateway pins the enrolled client's public identity, and the
client pins the gateway identity supplied by the invite.

Later connections must prove possession of the matching private key with a
fresh signed challenge. Revocation closes the active connection and prevents
that identity from reconnecting.

This authentication is mandatory for every connection option. Cloudflare,
Tailscale, SSH, TLS certificates, and source-IP rules are independent outer
layers; none is accepted as a substitute for the enrolled PwrAgent identity.

## Direct and Local Connections

### Same-machine loopback

A listener on `127.0.0.1` is reachable only by processes on the same machine.
This is suitable for local development and for testing two isolated PwrAgent
profiles. A plain `ws://` URL does not cross a physical network in this setup.

Other local processes can still attempt to connect, so PwrAgent peer
authentication remains required.

### Direct LAN

A listener on `0.0.0.0`, a LAN address, or another non-loopback interface is a
different security posture. Plain `ws://` traffic crossing that interface is
readable and modifiable by an on-path attacker even though an unenrolled caller
cannot complete PwrAgent authentication.

Do not describe signed enrollment as transport encryption. Direct LAN use
needs PwrAgent's encrypted transport or an encrypted network layer such as
Tailscale, SSH, or another trusted VPN.

## PwrAgent Encrypted Transport

PwrAgent's encrypted transport protects every federation connection, including
direct connections that do not use a public tunnel, external certificate
authority, or stable DNS hostname. It uses a persistent channel key in addition
to the canonical Ed25519 instance identity.

The implementation uses `Noise_IK_25519_ChaChaPoly_SHA256`:

- X25519 static and ephemeral keys establish the channel
- ChaCha20-Poly1305 encrypts and authenticates every frame
- SHA-256 supplies the Noise transcript and key derivation hash
- the initiator knows the gateway's static Noise key before connecting
- the gateway learns and authenticates the enrolled client's static key during
  the handshake

The secure channel provides:

- mutual proof that the parties possess the expected channel keys
- confidentiality and authenticated encryption for every federation frame
- forward secrecy from fresh ephemeral handshake keys
- monotonically increasing transport nonces so replayed frames fail
- binding between the encrypted channel and PwrAgent's signed identity proof
- a pinned gateway channel key carried by the enrollment invite
- fail-closed behavior when the expected gateway key is missing or wrong

The WebSocket remains the framing and streaming transport. The Noise handshake
runs before PwrAgent identity authentication, and the signed identity proof is
bound to the Noise handshake hash. Application frames inside the WebSocket are
ciphertext rather than readable JSON.

The gateway Noise public key is embedded in the one-time enrollment invite and
pinned by the importing client. The private key is generated automatically and
stored through the desktop credential store. There is deliberately no setting
that disables Noise: encryption is part of the federation transport contract.

This protects PwrAgent traffic, but it does not provide automatic LAN discovery,
NAT traversal, a public hostname, or a firewall. Operators still choose how one
machine routes to the other.

## SSH Reverse Tunnel

SSH is an external transport option, not a PwrAgent-managed feature. A reverse
tunnel is useful when a development VM can accept SSH connections but should
not expose a PwrAgent listener to the LAN.

Example topology:

```text
PwrAgent client in VM
  -> VM 127.0.0.1:47830
  -> SSH reverse forwarding
  -> host 127.0.0.1:47830
  -> PwrAgent gateway
```

SSH encrypts the cross-machine segment and controls who may create the tunnel.
PwrAgent still performs enrollment and signed peer authentication inside it.
The SSH process lifecycle, host-key verification, keys, and reconnect behavior
remain the operator's responsibility.

## Tailscale

PwrAgent can use a Tailscale-provided URL or route without treating Tailscale
identity as PwrAgent identity.

### Tailscale Serve

Tailscale Serve is the preferred Tailscale posture for personal federation. It
proxies a loopback HTTP service to an HTTPS URL available only inside the
operator's tailnet. Tailscale network grants apply before a peer can reach the
service.

```text
Enrolled client in tailnet
  -> Tailscale HTTPS endpoint
  -> encrypted tailnet path
  -> Tailscale Serve on gateway machine
  -> gateway 127.0.0.1:47830
  -> PwrAgent peer authentication
```

Keep the PwrAgent gateway on loopback. Do not trust forwarded identity headers
as a replacement for PwrAgent enrollment. Devices outside the tailnet should
not be able to reach the Serve URL.

Settings -> Federation -> Tailscale Serve / Funnel Setup detects the local
Tailscale CLI and connected tailnet. **Set up Tailscale Serve** asks the CLI to
proxy only this route:

```text
https://<device>.<tailnet>.ts.net/pwragent-federation
  -> http://127.0.0.1:<federation-port>
```

Before invoking Tailscale, Settings switches the gateway listener to loopback,
waits for the runtime restart, and verifies that PwrAgent owns the selected
port. The main process repeats that ownership check immediately before the CLI
mutation. A failed or occupied listener therefore cannot publish an unrelated
localhost service. After setup succeeds, PwrAgent stores the matching `wss://`
URL as its Public URL. Tailscale owns login, device identity, HTTPS certificates,
and tailnet policy; PwrAgent never reads or stores Tailscale credentials.

### Tailscale Funnel

Tailscale Funnel publishes a local service to the public Internet through a
Tailscale hostname and encrypted relay. It hides the machine's public address
and avoids an inbound router port, but the hostname is public. Funnel does not
provide Tailscale Serve's tailnet-user identity headers.

Random Internet clients can therefore reach the public Funnel edge and attempt
the WebSocket upgrade. PwrAgent authentication is the primary admission gate at
the application. Use Funnel only when public reachability is intentional and
document its wider attack surface.

The Settings action requires an explicit acknowledgement that Funnel creates a
public endpoint. It uses the same dedicated `/pwragent-federation` path. Setup
never calls `tailscale serve reset` or `tailscale funnel reset`, because those
commands can delete unrelated routes. Current Tailscale CLI releases do not
offer a path-scoped removal command for a node-level handler, so operators must
inspect `tailscale serve status --json` and `tailscale funnel status --json`
before manually changing or resetting a machine with other handlers.

## Cloudflare Tunnel

Cloudflare Tunnel uses an outbound `cloudflared` connection from the gateway
machine to Cloudflare. The PwrAgent listener stays on `127.0.0.1`; no router
port or publicly routable origin address is required.

```text
Client
  -> Cloudflare edge
  -> Cloudflare Access, mTLS, WAF, or IP policy
  -> encrypted Cloudflare Tunnel
  -> cloudflared on gateway machine
  -> gateway 127.0.0.1:47830
  -> PwrAgent peer authentication
```

The gateway's Public URL is the `wss://` Cloudflare hostname. That URL is
embedded in newly generated enrollment invites.

### Without an edge admission policy

The origin IP and listener remain hidden, but the hostname is public. Random
Internet clients can reach Cloudflare and their accepted HTTP/WebSocket upgrade
traffic can traverse the tunnel to the loopback listener. PwrAgent must reject
unenrolled callers.

This is better than opening a home-network port, but it exposes more of the
application protocol to hostile traffic than a deny-by-default Access policy.

### Cloudflare Access service token

A Service Auth policy can require the `CF-Access-Client-Id` and
`CF-Access-Client-Secret` headers. PwrAgent stores these values in encrypted
desktop secret storage and supplies them only on the WebSocket upgrade.

Cloudflare rejects a request without the correct token before forwarding it
through the tunnel. A service token is a bearer credential: anyone who copies
both values can pass this outer gate until the token expires or is revoked.
PwrAgent peer authentication still protects the inner control plane.

### Cloudflare Access mTLS

An Access Service Auth policy can require a client certificate signed by a CA
associated with the federation hostname. PwrAgent stores the PEM certificate
and private key in encrypted desktop secret storage and supplies them during
the TLS handshake.

With the exact hostname covered by the Access application and no applicable
Bypass policy, a caller without a valid certificate is rejected at Cloudflare's
edge. It does not receive a WebSocket upgrade, and its request is not forwarded
through the tunnel to `cloudflared` or the PwrAgent listener.

The `Valid Certificate` selector accepts any valid client certificate issued by
the configured CA. Use a narrower Common Name policy or separate certificate
issuance policy when individual-device admission matters. Certificate expiry,
revocation, and private-key protection remain operational responsibilities.

The PwrAgent mTLS setting only presents client credentials. It does not create
the CA, issue a certificate, configure the Cloudflare Access application, or
attach an mTLS policy. Access service tokens and mTLS may be required together
for defense in depth.

## Rejection Boundaries

| Failure | Rejected by | Reaches PwrAgent listener? |
|---|---|---|
| Client outside a Tailscale Serve grant | Tailscale network policy | No |
| Random caller to a Tailscale Funnel hostname | No outer identity gate by default | Yes, unless another edge control is added |
| Missing Cloudflare Access service token | Cloudflare Access | No |
| Missing or invalid Cloudflare client certificate | Cloudflare Access mTLS | No |
| Caller with edge credentials but no PwrAgent enrollment | PwrAgent gateway | Yes, then rejected during authentication |
| Revoked PwrAgent identity | PwrAgent gateway | Yes, then rejected during authentication |
| Wrong gateway identity returned to a client | PwrAgent client | Connection rejected |
| Modified encrypted PwrAgent frame | PwrAgent secure channel | Frame/session rejected |

## Recommended Postures

### Same machine

- Loopback listener
- PwrAgent enrollment and signed peer authentication

### Private personal devices

- Tailscale Serve to a loopback PwrAgent listener
- Restrictive tailnet grants
- PwrAgent enrollment and signed peer authentication
- PwrAgent encrypted transport as an additional application-layer boundary

### Public Internet hostname

- Loopback PwrAgent listener
- Cloudflare Tunnel
- Deny-by-default Access application
- mTLS or a narrowly scoped Access service token; both when practical
- PwrAgent enrollment and signed peer authentication
- No direct router or firewall exposure of the listener

### Development VM

- Loopback listener on both machines
- SSH reverse tunnel or Tailscale Serve
- Dedicated test profiles and roots
- PwrAgent enrollment and signed peer authentication

## Verification Checklist

Documentation should not claim a connection option works end to end until the
following behavior has been observed:

- correct client connects and both instances report Connected
- client verifies the intended gateway identity
- unenrolled and revoked clients are rejected
- live remote events stream without refresh
- disconnect and reconnect states recover without local fallback
- remote paths and filesystem changes occur only on the owning machine
- packet or raw-frame inspection does not reveal federation JSON when PwrAgent
  encrypted transport is enabled
- modified and replayed encrypted frames are rejected
- Tailscale Serve URL is unreachable from a device outside the allowed tailnet
- Tailscale Funnel is treated as publicly reachable
- Cloudflare hostname without Access credentials receives `401` or `403`
- Cloudflare mTLS hostname without a client certificate receives `403`
- rejected Cloudflare traffic produces no connection or authentication event at
  the local PwrAgent listener
- correctly credentialed Cloudflare traffic still fails without an enrolled
  PwrAgent identity
- tunnel interruption produces an unavailable state and recovery reconnects the
  same peer identity

Record the exact outer service configuration during testing. A successful
PwrAgent connection alone cannot prove that an edge rejection policy was active.

## Current Validation Status

The federation baseline has been manually exercised between a host and a macOS
development VM through an SSH reverse tunnel. That proves the remote workflow
and the SSH-protected route, not Cloudflare or Tailscale.

The Noise implementation passes the official Noise protocol vectors plus
focused coverage for tampering, replay/counter behavior, wrong gateway pins,
real-socket encrypted RPC, invite key pinning, identity channel binding, and
credential-store persistence. A fresh two-machine manual run and raw-frame
inspection remain to be completed before documentation claims live validation.

Cloudflare configuration, secret storage, and client credential plumbing have
automated coverage, but the Cloudflare Tunnel, Access service-token, and mTLS
paths still require live validation against a real Cloudflare account.

Tailscale Serve/Funnel discovery and setup now have focused automated coverage.
The implementation reports only sanitized local device status to the renderer,
uses a dedicated path, never invokes a broad reset, requires Funnel exposure
acknowledgement, and writes the resulting `wss://` URL into PwrAgent gateway
settings. Live Serve and Funnel validation remain to be completed after the
operator selects the intended Tailscale account.

## Dogfood Environment Readiness and Morning Runbook

The following observations were read-only and specific to the test environment
on August 4, 2026. They are not product prerequisites:

- the Tailscale CLI is installed and connected; no Serve or Funnel handler was
  configured during the overnight implementation
- `cloudflared` 2026.2.0 is installed, but the local CLI has no default origin
  certificate and therefore cannot administer account tunnels by name
- the Cloudflare Zero Trust account is on the Free plan and already has working
  Tunnel and Access resources, so the required product surfaces are available
- no dedicated PwrAgent federation tunnel, Access application, service token,
  or mTLS root certificate was created
- the Cloudflare mTLS certificate list is currently empty

### Tailscale live test

1. Confirm the host and VM are signed into the intended test tailnet.
2. Start isolated host and VM PwrAgent profiles with the gateway listener on
   `127.0.0.1`.
3. In host Settings, confirm Tailscale reports the expected tailnet and DNS
   name. Do not continue if the account is wrong.
4. Select **Set up Tailscale Serve**. Verify the dedicated path appears in
   `tailscale serve status --json` without changing unrelated handlers.
5. Enroll the VM from the new invite and run browse, prompt streaming, steer,
   interrupt, approval, remote-file, and reconnect scenarios.
6. Confirm the Serve URL is unavailable from a device outside the authorized
   tailnet or outside the applicable grants.
7. After the private workflow passes, acknowledge public exposure and select
   **Set up Tailscale Funnel**.
8. Confirm the hostname is publicly reachable, an unenrolled caller is rejected
   by PwrAgent, and an enrolled client completes the Noise and identity
   handshakes.
9. Inspect both status documents before cleanup. Do not use a broad Tailscale
   reset if the machine has unrelated Serve/Funnel handlers.

### Cloudflare live test

Use new, clearly named dogfood resources. Do not edit or reuse an existing
tunnel, Access application, policy, service credential, or hostname.

1. Choose a temporary hostname in a Cloudflare-managed test domain, for example
   `federation-dogfood.example.com`.
2. Create a dedicated remotely managed tunnel and run its token-based
   `cloudflared` connector on the host. Do not depend on the absent local origin
   certificate.
3. Map only the temporary hostname/path to
   `http://127.0.0.1:<federation-port>` and set the PwrAgent Public URL to the
   corresponding `wss://` URL.
4. Create a dedicated self-hosted Access application with a deny-by-default
   Service Auth policy. Do not add a Bypass policy covering the hostname.
5. For the service-token pass, create a short-lived dedicated token, require it
   in the Access policy, store its ID and secret in PwrAgent Settings, and enable
   Access service auth.
6. Verify a request without the token is rejected at the Cloudflare edge and
   produces no PwrAgent connection diagnostic. Then verify the correct token
   passes the edge but an unenrolled PwrAgent still fails the inner handshake.
7. For the mTLS pass, create a temporary test CA and client certificate, upload
   only the CA certificate to Cloudflare, associate the exact hostname, and add
   a `Valid Certificate` or narrower Common Name Service Auth rule. Store the
   client certificate and key in PwrAgent Settings and enable mTLS.
8. Verify a request without the client certificate is rejected at Cloudflare
   and never reaches the local listener. Then verify the valid certificate
   passes the edge but still requires the pinned Noise gateway and enrolled
   PwrAgent identity.
9. Run the full remote workflow, interrupt the connector to observe unavailable
   and recovery states, and compare Cloudflare Access logs with PwrAgent
   diagnostic timestamps.
10. Remove only the temporary dogfood hostname, Access application, policies,
    credentials, certificate objects, and tunnel after recording evidence.
