# Federation activity accounting

The monitor is process-owned, local-only instrumentation. Opening the status
popover or detached Activity window polls local IPC every two seconds. It never
polls a remote peer and never subscribes another window to backend event fanout.
Closing the popover stops its polling. Each surface has at most one read in flight.

## Byte and event boundaries

The transport reports **envelope messages only**. These measurements are not NIC
traffic totals or TCP/TLS bandwidth measurements.

| Field | Measurement |
| --- | --- |
| Requests | Successful transport sends / decoded receives of request envelopes |
| Responses | Response and error envelopes (including errors without a request ID) |
| Notifications | Notification envelopes |
| Other envelopes | Binary attachment chunks and unrecognized decoded envelope kinds |
| Data bytes | Serialized socket payload before compression or Noise encryption |
| Wire bytes | Encoded WebSocket application-message payload, including a Noise tag when present |

Data includes the socket envelope wrapper, protocol metadata, UTF-8 JSON and the
binary blob prefix/header/tail. It is not just RPC result or attachment content.
Wire excludes WebSocket headers/masking, TCP, TLS, retransmission and IP overhead.
Noise/authentication handshakes, WebSocket ping/pong/close control frames and
frames that fail socket-payload decoding are excluded. A routing or authorization
rejection after decoding does not remove an already measured transfer. Protocol control RPCs and notifications
that use ordinary envelopes are included in their respective event categories.
The UI's **What is measured** disclosure repeats these limits.

A send means accepted by the local WebSocket send call; it is not acknowledged
remote delivery. A closed socket that sends nothing produces no transfer sample.
A receive is sampled after decoding succeeds and before routing. Regular and
backpressure-aware sends have the same accounting boundary.

The encoder and decoder retain the serialization length in a weak-key numeric
map. The keys cannot extend envelope lifetime; the ledger retains no envelopes,
methods, request IDs, text, attachments or other payloads. This avoids a second
serialization just to measure bytes.

## Compatibility with compression PR #1255

The existing `onEnvelopeTransfer.byteCount` remains the encoded byte count.
`dataByteCount` is captured inside `encodeFederationSocketPayload`, before the
proposed Brotli codec, and inside `decodeFederationSocketPayload`, after the
proposed decompression. That boundary works for plain, Noise-encrypted and
mixed compressed/uncompressed connections. Binary blobs use their actual binary
representation, not JSON serialization of a byte array. This PR adds no
compression negotiation or codec from #1255.

Transport tests measure both ends of a real loopback plain/Noise connection,
including the exact 16-byte Noise tag and a binary backpressure send. Ledger
regressions simulate mixed 100/116/36-byte encoded frames for equal 100-byte data
payloads. The compression PR should retain these taps and extend its codec tests
to assert decoded versus encoded lengths when it lands.

## Physical and logical attribution

Physical totals are the sum of transfers on this process's immediate direct or
gateway connections. At a gateway, receiving from A and forwarding to B are two
physical transfers, on different connections. This is real local traffic.

Logical endpoints are an **alternate view**, never added to physical totals.
An outgoing envelope is logical traffic only when this instance is its source;
an incoming envelope is logical traffic only when addressed to this instance or
broadcast without a target. Transit forwarding is excluded. An endpoint using a
gateway therefore shows one physical peer (the gateway) and its actual logical
counterpart. Logical encoded bytes measure that endpoint's hop, not a whole route.
Broadcast fanout counts endpoint deliveries, not unique broadcast IDs.

## Retention and cost

The ledger retains one-second buckets for at most one hour and process-lifetime
counters. Rolling windows use the last 60/300/3600 second buckets including the
current second; expiry is quantized to one second. Charts aggregate these into
360 ten-second bins, including idle zero bins. Process-lifetime selection keeps
the last hour of rate history while displaying lifetime totals.

Physical and logical peer maps each keep at most 32 distinct named peers plus an
**Other peers** overflow aggregate. Peer IDs are bounded to 120 characters;
malformed endpoint IDs use a fixed Unknown endpoint label. Global totals and the overflow retain every
transfer even when attribution is full. Reconnects and Federation stop/start do
not reset counters; exiting the app process does. The legacy health-only ledger
is also capped at 128 peers.

The hard storage bound is 67 series, each with at most 3600 bucket records and one
lifetime record. Only the selected series returns chart history over IPC; the
popover requests no chart history. There are no per-event timers or SQLite
writes. The monitor's added SQLite commit and WAL budget is **0 commits and
0 MB/day**, independent of event volume. User toggles use the existing settings
write and runtime restart boundary; monitoring does not persist anything.

## UI and runtime ownership

The Star Map trigger opens its existing map on click. Hover or keyboard focus
opens an interactive, nonmodal status panel with focus retention, pointer grace,
outside dismissal and Escape. The panel and Activity screen distinguish the
saved mode from `running` and display the existing lease holder and reason.
Saving an enabled mode does not imply a successful lease acquisition.

The on/off toggle saves `disabled` and restores the last enabled mode within this
process. If the process starts disabled, On infers client from saved gateway
enrollment endpoints, otherwise gateway; a different role remains selectable in
Federation Settings. Concurrent toggle operations are serialized and await the
normal runtime restart. Failed writes leave the previous state visible.

The detached window uses existing auxiliary-window placement, security, theme,
titlebar and appearance-broadcast helpers. Reopening focuses its singleton;
closing it leaves the main window running. Only its own renderer may change its
always-on-top state. Topmost is optional and resets when the window closes.
