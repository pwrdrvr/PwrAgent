# Federation thread services

## Scope and trust

An agent may **declare** a service running on its own machine with
`advertise_service`, inspect its declarations with `list_services`, and withdraw
one with `remove_service`. These are ordinary discoverable PwrAgent tools. Tool
context supplies the backend and thread; arguments cannot select another owner
or thread. Declaration only creates an in-memory record. It opens no socket,
changes no firewall, enrolls nobody, and grants no tunnel lease.

The desktop's thread Services rows show owner instance, literal loopback address,
port, protocol, expiry, and active local mapping. An explicit **Connect** creates
a viewer-bound lease and a listener on `127.0.0.1`, with an OS-assigned port.
**Open** separately opens that exact generated HTTP(S) URL. **Disconnect** closes
the listener, sockets, and lease. **Remove** revokes the declaration and every
lease. Neither agent tools nor automatic reconnect can activate forwarding.

Federation currently trusts enrolled instances as the same operator
(`federation-policy.ts`), not individual remote users. The new protocol preserves
that boundary: a trusted peer can request a lease, but only for an advertised
service. It is not a cryptographic proof of a UI click. The desktop exposes lease
creation only through user IPC, never an agent tool. Future multi-user Federation
must add principal/thread ACLs before claiming isolation between remote users.

## Advertisement and lifecycle

Records contain owner instance ID, owner runtime session UUID, backend, thread ID,
service UUID, literal target (`127.0.0.1` or `::1`), unprivileged port, name,
description, requested protocol (`http`, `https`, `tcp`), creation and expiry.
No hostname, URL, credentials, arbitrary metadata blob, or caller-asserted owner
is accepted. Exact literals avoid DNS and rebinding. The declaration is the
owner-side target allowlist; tunnel requests carry IDs, never destinations.

Declarations expire (one hour by default, at most 24 hours), disappear on process
exit, and are removed when their thread is no longer present. Re-advertising the
same endpoint renews it. This first slice binds to the PwrAgent runtime session,
not a guessed OS PID: it cannot detect port reuse by another process. Services
should be removed when stopped; expiry bounds forgotten declarations. A refused
TCP connection fails visibly. A restart requires another declaration.

Viewer leases expire without renewal. Peer/route loss closes active forwards;
reconnect requires a fresh click. Closing the viewing window or leaving the thread
releases that window's forwards. Other windows have independent leases. Removing
a service or expiring it destroys every socket using it. No state is persisted;
new SQLite commits and projected WAL cost are zero (0 MB/day).

## Wire protocol v1

Additive `service_forward_v1` capability gates `services.v1.*` RPCs. Unknown/old
owners show an upgrade-required state. No change to the Federation envelope,
gateway, Noise, enrollment, or global protocol version is needed. Every hop must
understand/grant the capability. Existing router origin checks accept only a
direct authenticated source or the configured trusted upstream gateway. Gateway
relays preserve origin and target; leases and streams bind to that origin and
the exact service/thread. Gateway trust remains transitive, not independently
signed or encrypted end-to-end between sibling clients. Existing transport TLS
and optional per-hop Noise apply; payloads must never enter diagnostic captures.

| RPC | Purpose |
| --- | --- |
| `list` | Bounded inventory for one backend/thread |
| `lease` | Explicit per-service activation; returns an opaque viewer-bound lease |
| `renew` | Keep an existing lease alive; cannot change its service or target |
| `release` | Revoke lease and all its streams |
| `open` | Connect a TCP stream to the lease's fixed loopback endpoint |
| `exchange` | Ordered bidirectional bounded data + independent FIN bits |
| `close` | Cancel one stream |
| `remove` | Withdraw a declaration in the selected thread |

Use one outstanding exchange per stream, a 16 KiB raw-byte quantum per direction,
strict canonical base64 validation, monotonically increasing sequence numbers,
bounded streams/leases globally and per peer, and bounded idle leases/streams.
Stop-and-wait supplies credit: the next exchange waits for local socket writes
to complete. Non-flowing socket reads propagate backpressure. An idle exchange
waits briefly for readable data; a busy exchange yields between quanta, with an
aggregate owner scheduler limiting throughput so service traffic cannot enqueue
unbounded frames ahead of agent events. Byte counters measure decoded TCP bytes,
separately from existing Federation wire-byte accounting. There is no per-chunk
database write. FIN is distinct from cancellation; each direction may half-close.
Failed/ambiguous exchanges close the stream instead of replaying bytes.

This favors correctness and reviewable integration over bulk throughput. WAN
throughput is limited to roughly one quantum per round trip per stream. A later
negotiated v2 can use binary frames and window credits with shared-transport
priority scheduling. Do not silently claim v1 has that throughput.

## Browser and other protocols

The tunnel is byte-transparent TCP. HTTP Upgrade/WebSockets and relative-path
HMR work without parsing or header rewriting. HTTPS is TLS pass-through: the
application terminates TLS and its certificate must match the local URL; PwrAgent
does not issue certificates or disable validation. Raw TCP is supported, UDP and
Unix sockets are not. Raw TCP has no browser Open action.

The browser sees `127.0.0.1:<assigned-port>`. Host, Origin, cookies, redirects,
absolute asset URLs, and CORS rules are unchanged bytes. Apps must accept/configure
that origin; hardcoded owner ports/hostnames and HMR URLs are not automatically
rewritten. Secure cookies still require HTTPS; domain cookies for the owner's
hostname will not become local cookies. Localhost cookies are not port-isolated.
Use benign development data and separate browser profiles when isolation matters.
Local listeners are reachable by local processes, as with other loopback dev
servers; they are not a local multi-user authorization boundary.

## Verification and applicability

Unit/integration coverage will drive real loopback HTTP and WebSocket fixtures
through owner/viewer services and authenticated Federation routing, including a
gateway hop, blocked endpoints, wrong peer/thread, expiry/removal, half-close,
limits, cancellation, backpressure and disconnect. UI tests use contrived data.
Cross-machine validation may use only existing enrolled peers, never public CI
runners; report separately if an existing peer cannot run the branch.

Mobile can reuse discovery and permission concepts. A mobile viewer needs a
platform-specific loopback listener and foreground lifetime support; otherwise
it can display declarations without offering Connect. No cloud/public URL is
implied, and mobile implementation is not a day-one dependency.
