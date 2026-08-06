# PwrAgent Federation Operator Guide

PwrAgent federation connects multiple PwrAgent profiles through an authenticated
WebSocket control plane. A gateway accepts connections, clients connect to that
gateway, and the gateway relays authorized traffic between clients.

Federation is disabled by default. The first supported remote posture is a
loopback gateway listener published through Cloudflare Tunnel. Direct
localhost/LAN WebSocket URLs use the same PwrAgent enrollment and peer
authentication.

## Security Boundaries

Federation uses two independent admission layers:

1. Cloudflare can restrict which traffic reaches the tunnel hostname with IP,
   Access service-token, or mTLS policy.
2. PwrAgent always requires an enrolled instance identity and a signed
   challenge. Cloudflare headers or certificates never replace PwrAgent peer
   authentication.

Each PwrAgent profile owns an Ed25519 identity key in encrypted desktop secret
storage. Enrollment invites are short-lived and single-use. The gateway stores
the enrolled public identity, while the client pins the gateway public identity
from the invite. Revocation closes the active gateway connection and blocks
reconnects with that identity.

Keep the gateway listener on `127.0.0.1` when using `cloudflared`. Do not expose
the listener port through a router or host firewall.

## Local Dogfood Setup

Build the desktop app once, then launch isolated profiles:

```sh
pnpm --filter @pwragent/desktop build
PWRAGENT_PROFILE=gateway pnpm --filter @pwragent/desktop preview
PWRAGENT_PROFILE=laptop pnpm --filter @pwragent/desktop preview
```

On the gateway profile, open Settings -> Federation and set:

- Mode: `gateway`
- Listen host: `127.0.0.1`
- Listen port: `47830`
- Public URL: `ws://127.0.0.1:47830`

Save, generate an invite, and import it on the laptop profile. The imported
profile switches to client mode and connects immediately.

Both profiles should list the other instance as Connected. Open the remote
instance from either profile. A client can also open the gateway or another
connected client; sibling traffic is relayed by the gateway.

## Cloudflare Tunnel

Cloudflare Tunnel supports WebSockets and connects to the origin without an
inbound public port. See Cloudflare's
[Tunnel overview](https://developers.cloudflare.com/tunnel/) and
[Tunnel WebSocket support](https://developers.cloudflare.com/cloudflare-one/faq/cloudflare-tunnels-faq/).

Create a named tunnel and DNS route:

```sh
cloudflared tunnel login
cloudflared tunnel create pwragent-federation
cloudflared tunnel route dns pwragent-federation pwragent.example.com
```

Use a `cloudflared` configuration like:

```yaml
tunnel: YOUR_TUNNEL_ID
credentials-file: /absolute/path/to/YOUR_TUNNEL_ID.json

ingress:
  - hostname: pwragent.example.com
    service: http://127.0.0.1:47830
  - service: http_status:404
```

Start the tunnel:

```sh
cloudflared tunnel run pwragent-federation
```

On the gateway, keep the listener at `127.0.0.1:47830` and set Public URL to
`wss://pwragent.example.com`. Generate new invites after changing the public
URL because the URL is embedded in each invite.

### Source IP Restriction

An IP allow rule at Cloudflare is a useful outer gate while the gateway is at a
stable location. Verify the rule against the hostname before relying on it and
remove or change it deliberately when the connecting laptop moves networks.
PwrAgent enrollment remains mandatory whether or not the IP rule is active.

### Cloudflare Access Service Token

Cloudflare Access service tokens use the
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Configure a
Self-hosted Access application and a Service Auth policy for the federation
hostname. Cloudflare documents the current flow in
[Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
and [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

On every client profile, before importing its federation invite:

1. Open Settings -> Federation -> Cloudflare.
2. Enable Access service auth.
3. Enter the Access client ID and client secret.
4. Select Save edge policy.
5. Import the federation invite.

PwrAgent stores both values in encrypted desktop secret storage and sends them
only in the WebSocket upgrade request. If either value is missing while the
mode is enabled, the connector fails closed with a Settings diagnostic.

### Cloudflare Access mTLS

Cloudflare Access can enforce a Service Auth policy with a Valid Certificate or
Common Name selector. Its current setup and certificate requirements are in
[Cloudflare Access mTLS](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/mutual-tls-authentication/).
Availability depends on the Cloudflare account and product configuration; check
the dashboard before treating mTLS as an available outer gate.

Issue each client a certificate and private key from the CA associated with the
federation hostname. On the client profile, before importing its invite:

1. Open Settings -> Federation -> Cloudflare.
2. Enable mTLS.
3. Paste the PEM client certificate and matching PEM private key.
4. Select Save edge policy.
5. Import the federation invite.

The private key stays in encrypted desktop secret storage. PwrAgent supplies
the certificate and key only during the TLS handshake. Missing certificate
material causes a closed failure before a WebSocket is opened.

Access service tokens and mTLS can be enabled together when the Access policy
requires both.

## Remote Operation

A remote window routes its navigation, thread reads, prompt submission,
steering, interruption, compaction, approvals, model and execution settings,
environment selection/actions, environment action stop, reviews, forks,
scheduled-action list/create/update/cancel/send-now, launchpad materialization,
and workspace handoff to the selected instance. The owning instance persists,
times, and dispatches scheduled work. Backend events and environment setup
output stream back with the source instance identity.

Live backend events are subscription-driven. Opening a remote workspace
subscribes that window to its owning instance and closing it unsubscribes.
Star Map and messaging establish their own narrower, instance-scoped
subscriptions only while those features need them. Merely connecting or
enrolling a peer does not opt it into transcript, approval, scheduler, PR, or
error event traffic. Environment setup output remains a targeted response to
the operation that started it rather than a broadcast stream.

Global thread search fans out metadata queries to connected peers. Remote
results carry their instance label and open directly in a window scoped to that
instance.

Messaging thread browse includes connected remote threads with an instance
label. Selecting one persists its full federated identity, so prompts, steering,
interrupts, compaction, settings changes, approvals, status reads, and streamed
events continue to route to the owning instance. Messaging schedule creation
and management use the same federated identity and require the peer's
`scheduled_actions` capability. A disconnected remote binding remains stored
and reports unavailable thread state rather than rebinding to a same-named
local thread.

Disconnected or revoked peers remain visible for diagnosis, but Open is
disabled. PwrAgent does not fall back to local execution when a remote target
is unavailable.

Remote filesystem paths describe the remote machine. Do not assume a path is
present on the machine displaying the remote window.

## Diagnostics And Revocation

Settings -> Federation shows:

- local mode, listener, public URL, and connector status
- peer role, status, protocol version, negotiated capabilities, and activity
- recent connection attempts, accepts, rejects, disconnects, relays, and errors
- redacted failure details without invites, private keys, or raw credentials

Select Revoke next to a peer to close its active gateway connection and prevent
that identity from reconnecting. Re-enrollment requires a fresh invite and a
new instance identity.

Common failures:

- `unknown_peer`: the client identity was never enrolled or local state was
  replaced; generate and import a new invite.
- `revoked_peer`: the gateway has revoked this identity.
- `bad_signature`: the stored private key does not match the enrolled public
  identity.
- HTTP `401` or `403` before a PwrAgent audit event: Cloudflare rejected the
  WebSocket upgrade. Check IP, Access token, or mTLS policy.
- Missing Cloudflare credential error: enable the edge mode only after storing
  all required fields.

## Threat Model

The design protects against arbitrary Internet clients reaching a tunnel,
unenrolled PwrAgent instances, replay of used enrollment invites, reconnect by
revoked identities, and accidental routing of remote commands to the local
profile.

It does not protect against a compromised enrolled machine, an attacker who can
use that profile's unlocked desktop secret storage, or commands explicitly
approved on a remote coding-agent thread. Treat every enrolled peer as able to
exercise the capabilities shown in Settings and revoke peers that are lost or
retired.

Peer-authored metadata — instance labels, purpose notes, thread titles, and
host facts (OS, hostname, CPU/RAM/disk figures) — flows into local agent
context through the federation tool catalog and federated search. An enrolled
peer can therefore place text in front of your agents; this is accepted under
the same trusted-operator boundary, and host facts are self-reported hints,
not verified measurements.

## Agent Access to Federation

In-thread agents get a `federation` tool catalog (`list_federation_instances`,
`list_instance_projects`, `create_instance_thread`,
`search_federation_threads`) that composes the same capability-gated RPCs the
UI uses; agent-originated cross-instance control is authorized exactly like
operator-originated control, with enrollment as the trust boundary. Instances
describe themselves to peers with the Settings → Federation "Instance name"
and "Purpose notes" fields, so agents can route work by what each machine is
for. Operators can steer routing and thread-startup defaults with
[`~/.pwragent/AGENTS.md`](agent-operator-preferences.md).
