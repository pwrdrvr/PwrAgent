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
Each direction has independent one-quantum credit: `receive` in requests and
`writable` in responses. A pending socket write withholds that direction's next
credit while the opposite direction can still drain. This avoids full-duplex
write deadlocks. Non-flowing socket reads propagate backpressure. An idle exchange
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


## Implementation and reproduction

Implemented in `federation-services.ts` (owner),
`federation-service-forwarder.ts` (viewer), the existing Federation tool catalog,
`ipc/federation-services.ts`, and `ThreadServices.tsx`. The runtime's local
identity supplies the owner; a remote window keeps its selected thread's source
instance rather than using the viewer's host. Window-scoped watch IDs prevent an
in-flight Connect from creating a listener after navigation or window teardown.

Start the checked-in fake-data HTTP/WebSocket demo on the owning instance:

```sh
pnpm --filter @pwragent/desktop exec node scripts/federation-service-demo.mjs 3000
```

It serves only inline invented data, never files, and updates a WebSocket counter
every second. Alternatively use an app bound to `127.0.0.1` or `::1`. Ask its
thread to call the normal tool:

```json
{"port":3000,"name":"Development preview","protocol":"http","ttlSeconds":3600}
```

That is `advertise_service` input. `list_services` takes `{}`;
`remove_service` takes `{"serviceId":"<returned-id>"}`. From a compatible
remote desktop, select the thread, expand **Services**, click **Connect**, then
**Open**. A local owner shows declarations and Remove; it does not create a
redundant local tunnel. Open is available only for HTTP(S). Leaving the thread or
closing the window disconnects its forwards. Removal revokes all viewers.

Use these repository-root verification commands with disposable fixture state:

```sh
pnpm test apps/desktop/src/main/__tests__/federation-services.test.ts apps/desktop/src/main/__tests__/federation-services-transport.test.ts
pnpm test apps/desktop/src/renderer/src/features/federation/__tests__/ThreadServices.test.tsx
pnpm test:desktop-e2e e2e/federation-services.spec.ts
```

The last command is a headed desktop test and must run through the repository's
PwrSuiteLab workflow on macOS. It uses a real authenticated in-process gateway,
real HTTP and WebSocket fixture, real Electron preload/IPC/runtime and renderer,
and writes `services-available.png` / `services-connected.png` under test results.
All thread and app contents are contrived. Fixtures enroll ephemeral identities
in private loopback test state only; they never join the operator's federation.

Observed automated coverage includes direct and relayed HTTP, unchanged Host,
Origin and Set-Cookie headers, WS messages, IPv6 literal loopback, TLS pass-through
with successful explicit CA trust and failed ordinary untrusted-cert validation,
TCP half-close, a 512 KiB upload/download alongside control RPCs, wrong origin,
missing capability, wrong peer and thread, frame limits, peer stream limits,
expiry, removal, refused/stopped target, late lease cancellation, listener closure,
window scoping, tool context validation, and explicit UI actions. The signed
transport test uses two Noise-encrypted clients through a third gateway and
checks that diagnostics contain no HTTP/WS body bytes.

### Deliberate v1 limits

- One quantum per direction per RPC; round-trip latency limits throughput. The
  owner globally schedules one exchange at least 4 ms apart (approximately
  4 MiB/s of raw data per direction), with 32 owner streams, 8 streams per
  authenticated peer, 64 leases, 16 leases per peer, 16 local forwards, and
  64 advertisements. Socket write stalls time out after 10 seconds. Independent
  directional credits keep a stalled writer from preventing opposite-direction
  progress. This does not replace global Federation scheduling for other traffic.
- Leases last 30 seconds and renew every 10 seconds; inactive owner streams reap
  after 30 seconds without exchange. Idle healthy WebSockets remain usable.
  Advertisements reap every second; thread availability is rechecked at most
  every 10 seconds. Viewer inventory refreshes every 3 seconds. Silent link loss
  therefore has bounded cleanup rather than an instantaneous disconnect signal.
- No OS process identity verification: a different process reusing the same port
  during an advertisement's lifetime is indistinguishable. No service restart
  replay, URL/header rewriting, public URL, UDP, automatic local port selection
  matching the owner, certificate issuance, or mobile listener.
- Known Federation listener ports are rejected. Other loopback APIs are not
  auto-discovered or automatically authorized: only explicit declarations are
  available. Local processes can access an active local listener. Application
  authentication and browser-origin protections still belong to the app.
- All enrolled peers share the same operator trust domain. Service names and
  descriptions are visible to trusted viewers of the thread; never put secrets
  there. Per-user roles and thread ACLs are a future Federation-level dependency.
- Live cross-machine validation requires compatible builds on owner, viewer,
  and relay. The existing enrolled peers inspected during development did not
  advertise `service_forward_v1`; no live peer was restarted, reenrolled, or
  given wider network access to make that test pass.


The local validation run passed 171 tests across the service, signed transport,
Federation runtime, tools, and renderer suites. The initial headed lab request
was refused with `e2e_display_busy`; no UI screenshot or live cross-machine pass
is claimed by those tests. The subsequent lab status also reported less than
0.5 GB of guest free space. The checked-in headed repro remains available when
the shared lab can stage and run it.
