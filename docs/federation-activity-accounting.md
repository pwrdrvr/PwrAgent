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
counters. Rolling windows use the last 60/300/600/3600 second buckets including the
current second; expiry is quantized to one second. Charts aggregate these into
360 ten-second bins, including idle zero bins. Sent and received tables show Last 1m, Last 10m, Last 1h and Total side by side,
independent of the chart range. The five-minute aggregate remains available in
IPC. Byte displays use decimal KB/MB/GB/TB (1 KB = 1,000 bytes), automatically
scaled per value; exact byte counts remain available in cell tooltips and IPC.

Physical and logical peer maps each keep at most 32 distinct named peers plus an
**Other peers** overflow aggregate. Peer IDs are bounded to 120 characters;
malformed endpoint IDs use a fixed Unknown endpoint label. Global totals and the overflow retain every
transfer even when attribution is full. Reconnects and Federation stop/start do
not reset counters; exiting the app process does. The legacy health-only ledger
is also capped at 128 peers.

The hard storage bound is 67 series, each with a fixed 3600-slot numeric ring and one
lifetime record. A timestamp tag makes expired slots invisible; recording overwrites
only its one-second slot and never scans or deletes an accumulated event list. Only the selected series returns chart history over IPC; the
popover requests no chart history. There are no per-event timers or SQLite
writes. The monitor's added SQLite commit and WAL budget is **0 commits and
0 MB/day**, independent of event volume. User toggles use the existing settings
write and runtime restart boundary; monitoring does not persist anything.

## Lifetime request/response size statistics

Each physical or logical series also exposes sample count, average, p50, minimum
and maximum uncompressed envelope size for sent/received requests and responses.
Responses include error envelopes; notifications and blob chunks do not enter
these distributions. These statistics span the process lifetime, survive rolling
expiry and reconnects, and follow the same per-peer/relay attribution as totals.
They do not depend on the selected chart window.

Count, sum and extrema are accumulated from all observations. Average is
sample-weighted. p50 uses the nearest-rank definition and is explicitly displayed
as an estimate: a fixed logarithmic histogram has 32 bins per power of two, with
midpoint relative error below 1.1%. Observed extrema bound the estimate. Empty
distributions show no size values instead of implying a zero-byte response.

Each populated distribution uses 1,698 numeric histogram bins (13,584 bytes),
covering all nonnegative safe-integer byte sizes. With at most four distributions
per series and 67 series, histogram storage is bounded to 3,640,512 bytes. It is
allocated lazily and does not grow with event count. No payloads or per-event size
lists are retained, and this adds no SQLite writes.

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


### Operator controls

The Activity window uses the shared On/Off switch. Reset clears the in-memory
monitor for every physical connection and logical endpoint: rolling history,
measurement-lifetime totals, peer entries, and request/response size histograms.
The "since" timestamp starts a new measurement interval. Reset does not restart
Federation, change configuration, reset transport health counters, or write SQLite.
Other open activity surfaces observe the reset on their next local poll.

Copy exports the selected attribution/peer as tab-separated plain text through
the existing clipboard bridge. It includes capture and interval-start timestamps,
all recent/total columns, size statistics, scaled and exact byte values, and the
accounting boundaries. It excludes payloads and chart samples.


### Performance and write-budget audit

Each transfer updates at most three series (global physical, physical peer, and
logical endpoint). Recording is O(1) with no peer scan, history scan, serialization,
logging, or persistence. A ring allocates lazily on its first transfer and holds
374,400 bytes: 3,600 timestamps and 12 counters per timestamp. The maximum across
67 series is 25,084,800 bytes for rings plus 3,640,512 bytes for size histograms,
**28,725,312 bytes total numeric backing storage**, plus small object/map overhead.
Reset releases those arrays. Old numeric slots remain allocated but cannot appear
in rolling totals after expiry; no payloads are retained.

Snapshots scan the fixed rings and fixed histograms: O(P × (H + B)), with P ≤ 67,
H = 3,600 and B = 4 × 1,698. Cost does not increase with message count or process
age. Only the selected chart's 360 points cross IPC. Each visible activity surface
polls locally every two seconds, after the previous read finishes. Closed surfaces
do not poll. The transport byte-length seam reuses existing serialization lengths
and weak envelope keys, without extending payload lifetime.

A local Node 24 stress audit on 2026-09-05 recorded 40 peers, requests and responses
in both directions every simulated second for two hours (1,152,000 transfers).
After both the first and second hour, numeric storage was exactly 28,725,312 bytes.
The second 576,000 transfers took 383 ms; 30 full snapshots had a 5.2 ms median and
9.0 ms maximum, with approximately 196 KB JSON per snapshot. These are local
microbenchmark measurements, not a latency guarantee for all machines. The prior
object-map representation measured approximately 68 MB retained and 85 ms median
snapshot time in the same audit; the fixed rings replace that implementation.

Regression coverage fills and wraps every ring with more than one million events,
asserts the exact storage cap and rolling counts, and checks Reset releases it.
`federation-activity-write-budget.test.ts` measures 10,000 transfers, reads, and
Reset with SQLite instrumentation enabled. Its checked-in budget is zero commits,
zero write statements and zero WAL bytes: **0 MB/day additional monitoring WAL**.
The monitored path also contains no filesystem or log calls. Explicit configuration
toggles still use the normal settings write boundary; clipboard export is user-driven.
