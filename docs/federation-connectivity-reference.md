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

PwrAgent's encrypted transport is intended to protect direct connections
without requiring a public tunnel, external certificate authority, or stable
DNS hostname. It uses a persistent channel key in addition to the canonical
Ed25519 instance identity.

The secure channel must provide:

- mutual proof that the parties possess the expected channel keys
- confidentiality and authenticated encryption for every federation frame
- forward secrecy from fresh ephemeral handshake keys
- monotonically increasing transport nonces so replayed frames fail
- binding between the encrypted channel and PwrAgent's signed identity proof
- a pinned gateway channel key carried by the enrollment invite
- fail-closed behavior when the expected gateway key is missing or wrong

The WebSocket remains the framing and streaming transport. Application frames
inside it are ciphertext rather than readable JSON.

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

### Tailscale Funnel

Tailscale Funnel publishes a local service to the public Internet through a
Tailscale hostname and encrypted relay. It hides the machine's public address
and avoids an inbound router port, but the hostname is public. Funnel does not
provide Tailscale Serve's tailnet-user identity headers.

Random Internet clients can therefore reach the public Funnel edge and attempt
the WebSocket upgrade. PwrAgent authentication is the primary admission gate at
the application. Use Funnel only when public reachability is intentional and
document its wider attack surface.

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

The merged federation baseline has been manually exercised between a host and a
macOS development VM through an SSH reverse tunnel. That proves the remote
workflow and the SSH-protected route, not Cloudflare, Tailscale, or the PwrAgent
encrypted transport.

Cloudflare configuration, secret storage, and client credential plumbing have
automated coverage, but the Cloudflare Tunnel, Access service-token, and mTLS
paths still require live validation against a real Cloudflare account.

Tailscale-specific federation setup and live validation have not yet been
completed.

An earlier Noise-based encrypted transport implementation passed official Noise
vectors, tamper and wrong-gateway tests, real-socket encrypted RPC coverage, and
project CI. It is being reintroduced on top of the merged federation baseline;
the validation status in this document should be updated when that work lands.
