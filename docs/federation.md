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

### Guided Cloudflare Access setup

Settings -> Federation -> Cloudflare Access walks a gateway through six
numbered steps: choose how clients get in, connect a scoped API token, install
`cloudflared`, create the protected endpoint, validate it, and share client
setup files. Account ID, Zone ID, hostname, and the sign-in allowlist can be
saved as a draft at any point; the API token is held only in memory. Creating
the endpoint saves the federation listener as `127.0.0.1:<port>` (and changes
`client` mode to `dual`) before anything is created in Cloudflare, and the
DNS record is published only after the Access policy has been read back.

PwrAgent runs `cloudflared` with `--no-autoupdate`, so the install step
compares the installed version with Cloudflare's latest GitHub release (checked
at most once a day) and names a newer one. Update it the way it was installed
(`brew upgrade cloudflared` for Homebrew), then stop and start the connector:
the running process keeps the old binary until it restarts.

The three admission choices:

| Choice | Cloudflare plan | Client credential |
|---|---|---|
| Service token (default) | Any Zero Trust plan, including Free | One Access service token per client, inside its setup file |
| Sign in with an identity | Any Zero Trust plan; Managed OAuth is Cloudflare Beta | None; each person signs in with an allowed email |
| Client certificate (mTLS) | Contract (Enterprise) only; refused on Free | One certificate per client from a PwrAgent-generated CA |

A client imports the encrypted `.pwrcf` file under "Connect this client". The
file's enrollment invite expires after 1, 4, 8, or 24 hours, chosen when it
is saved.

Access checks a credential only when a connection opens, so removing it from
the policy alone would leave an open session running. Revoking an issued
client therefore also revokes the federation peer that enrolled with its
setup file, which closes that session; an invite nobody has used yet is
retired instead.

Creating the endpoint uses the saved federation listener port, not an unsaved
edit in Configuration. The hostname is checked against existing Access
applications and DNS records before anything is created, and Connect suggests
the first of `federation.<zone>`, `federation-2.<zone>`, and so on that is
free; a second profile in the same account commonly holds the first.

A creation that stops partway lists what it has made in Cloudflare so far.
Resume finishes with those resources. If the listener port changed in the
meantime, Resume points the tunnel at the new port. Start over deletes exactly
those resources and clears the setup record. A published endpoint offers
Remove endpoint, which deletes the DNS record first, then the tunnel, the
Access application, and the credentials the setup issued. Both ask for
confirmation and delete only resources the setup recorded. After a failure a
retry picks up where the last attempt stopped, and a resource already deleted
by hand counts as gone.

A gateway bound to a specific address refuses a port that another process
holds on every interface. On macOS such a bind succeeds and silently takes the
other listener's loopback traffic, including a Cloudflare tunnel aimed at it.
The endpoint audit also fails when the tunnel's recorded port is not the port
the gateway is listening on.

### Cloudflare Access sign-in

The sign-in choice enables
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
on the Access application, with dynamic client registration limited to
`127.0.0.1` redirects, and adds two policies: an allow policy naming the
permitted emails, and a Service Auth policy admitting only the gateway's own
validation token so endpoint validation can run with no person present. The
audit fails if any third policy, an https redirect URI, or a changed email
list appears.

A client signs in in the system browser (authorization code with PKCE S256 and
an RFC 8707 resource indicator) and stores the grant encrypted under the
profile's `state/`. Before each connection it refreshes the 15-minute access
token and sends it as `Authorization: Bearer`, and while connected it
refreshes again a minute before each token expires, because Access checks the
token only at the WebSocket upgrade. A refused refresh — the two-week grant
lapsed, or the person was removed from the allowlist — closes the connection
and puts the client in a sign-in-required state that Federation health reports
as rejected; Settings -> Federation -> Cloudflare Access offers Sign in. A
modified client could ignore that, so revoke the peer to end its session at
once. Config key: `federation.cloudflare_access_oauth_enabled`.

The Access application's session duration is 15 minutes. On an application
with an identity policy, Access accepts its own session cookie in place of a
sign-in until that duration ends (24 hours by default), so the audit checks
it; endpoint validation does not replay the cookie on this gate.

If a login method refuses the person (GitHub reporting an email that is not
on the allowlist, for example), Access continues with an ordinary login for
the application and the browser never returns to PwrAgent. "Open the sign-in
page again" sends the browser back to the same waiting sign-in.

### Cloudflare Access Service Token

Cloudflare Access service tokens use the
`CF-Access-Client-Id` and `CF-Access-Client-Secret` headers. Configure a
Self-hosted Access application and a Service Auth policy for the federation
hostname. Cloudflare documents the current flow in
[Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
and [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).

The guided setup above issues these. To enter them by hand, on every client
profile, before importing its federation invite:

1. Open Settings -> Federation -> Cloudflare Access -> Enter Cloudflare
   credentials manually.
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
Access mTLS requires a Contract (Enterprise) Zero Trust plan: on a Free plan
the certificate authority upload is refused as "maximum number of certificates
has been reached" with none stored. This is distinct from zone-level client
certificates in the SSL/TLS product.

Issue each client a certificate and private key from the CA associated with the
federation hostname. On the client profile, before importing its invite:

1. Open Settings -> Federation -> Cloudflare Access -> Enter Cloudflare
   credentials manually.
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

Transcript subscriptions can request `eventStream: { protocol: 1,
subscriptionId }`. The owner acknowledges with `backend.eventStream` and a
new epoch before sending numbered `backend.event` notifications. Gateways
preserve the negotiation, acknowledgement, and sequence. The viewer catches
up after acknowledgement, including when an idle owner has a pending prompt,
and resubscribes on a sequence gap. Normal navigation timestamp
changes do not trigger transcript reads for mounted remote threads, whether
idle or active. A final item already delivered before an empty turn-completed
event satisfies completion without another snapshot. A recovery that arrives during an
older read remains pending until a read started after recovery completes.
Reselecting a cached remote thread also triggers window-local catch-up: another
window can keep the aggregate subscription alive while this window misses events.

On reconnect, authentication refreshes connection capabilities and the gateway
broadcasts a fresh peer directory and replays retained viewer subscriptions.
Stream negotiation lives in those subscriptions, not cached discovery metadata.
Remote idle status does not arm a delayed transcript read: it may precede the
terminal event or briefly lag turn admission. Epoch and sequence recovery own
remote catch-up.
The client keeps post-authentication frames queued until its runtime installs
the authenticated connection and restores subscription state, so an immediate
gateway replay cannot be discarded as coming from an unknown connection.

Within a negotiated stream, pricing, tool-accounting, and subagent notifications
send a full baseline followed by smaller patches. Stable record identities keep
array reordering from resending the intervening history. The receiver reconstructs the
existing backend notification before publishing it to the renderer. Baselines
are volatile, limited to 32 records and 4 MiB per stream, and never persisted.
A missing baseline triggers resubscription. Peers and gateways that do not
forward the negotiation retain the original full-notification format;
connection status changes still trigger viewer catch-up.

Selected configuration reads revalidate a separate canonical baseline; streamed
presentation changes cannot authorize actions. History pages survive configuration
invalidations when their collection revision is unchanged. A streamed collection
that matches the owner’s content hash does not need to be downloaded again.

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

The general `send_message_to_thread` tool also routes transparently across
federation. Remote create and search results carry cross-instance links and an
`instanceId`; newer tool definitions pass that owner directly. PwrAgent also
stores the `(instanceId, backend, threadId)` routing metadata in its own profile
database, so older active threads that call the original tool shape can still
resolve a previously created or discovered remote thread after a restart. A
known owner is checked for connectivity before dispatch, producing a structured
`peer_unavailable` result instead of trying the UUID against the local backend.
When no durable owner is known, compatibility fallback still resolves the exact
thread ID across connected peers. Exact UUID queries passed to
`search_federation_threads` use the same ownership lookup instead of relying on
fuzzy thread-list filtering.

The `read_thread`, `get_thread_status`, `mutate_thread`, and
`attach_thread_here` tools use the same local-first routing for exact thread
IDs. Callers may pass `instanceId` to route directly to a known owner, but it is
not required: after a local miss, PwrAgent checks durable ownership metadata
and then connected peers. This compatibility fallback also lets already-running
agent threads use remote routing before their persisted tool schema includes
the newer fields. Set `includeRemote: false` on these tools or
`send_message_to_thread` when an operation must stay local.

`search_threads` also includes metadata matches from connected Federation
instances by default, while preserving its richer local transcript, semantic,
Agent, model, and directory filters as local-only capabilities. Pass
`instanceId` to search one connected instance, or `includeRemote: false` for a
strictly local search. Supported backend, project, archive, and update-time
filters run on each instance before the global page limit; merged local and
remote pages report the combined total and whether more matches were truncated.
Remote transcript reads require `thread_detail`, remote
mutations require `turn_control`, remote messaging attachments require
`messaging_route`, and all exact-thread ownership resolution requires
`thread_navigation`.

Once a messaging surface is attached to a remote thread, its status card and
subsequent backend-driven refreshes read navigation state from that owning
instance. The gateway must not render a remote binding from its local thread
snapshot or silently fall back to a same-shaped local thread.

### Temporary frame diagnostics

Federation Activity and the Federation status popup expose a 60-second detailed
traffic capture. The deadline belongs to the local main process, so closing
the surface does not cancel it and an inactive renderer cannot prolong it.
Capture logs every envelope at info level with physical peer, logical endpoints,
method, request/thread identifiers, and encoded/uncompressed byte counts.
Response methods are correlated with their requests. Thread-read and accounting
sizes are included without payload contents. The setting is not persisted or
relayed to peers. Outside the capture window, the 200,000-byte large-frame
threshold remains in effect.
