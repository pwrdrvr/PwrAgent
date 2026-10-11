# Durable turn requests, protocol v1

New clients use `backend.submitTurnRequest` and `backend.getTurnRequest` through
Federation, or the equivalent authenticated adapter runtime methods. V1 prevents
duplicate **submission** after lost acknowledgements within a seven-day retention
window. It does not promise exactly-once provider execution or eventual delivery
across a nontransactional provider failure.

## Client contract

Negotiate `durable_turn_requests_v1` and `turn_control` at the owner and every
relay. Missing capability, `method_not_found`, or `request_unsupported` means this
path is unavailable. Do not downgrade a durable outbox entry to `backend.startTurn`
or `backend.steerTurn`. Legacy desktop, web/IPC, MCP and messaging calls retain
their current semantics and do not acquire a new reliability guarantee.

At initial enqueue, persist the following **before** attempting a network call:

```ts
{
  clientRequest: {
    version: 1,
    id: "<lowercase RFC UUID>",
    createdAt: 1800000000000, // integer UTC epoch milliseconds
    payloadHash: "<lowercase SHA-256 hex>",
  },
  request: {
    backend: "codex",
    threadId: "<existing thread>",
    input: [{ type: "text", text: "Hello" }],
  },
}
```

Persist the original owner instance, ingress authority, exact request fields,
timestamp and hash with the UUID. Reconnects, app restarts and lost-ACK retries
reuse them unchanged. New UUIDs with identical content are distinct prompts.
Do not mint another UUID automatically for an uncertain request.

`canonicalDurableTurnRequest(ownerInstanceId, submission)` in `@pwragent/shared`
returns the UTF-8 JSON to hash with the client's native SHA-256 implementation:

```ts
{
  version: 1,
  createdAt: submission.clientRequest.createdAt,
  operation: "startTurn",
  destination: { instanceId: ownerInstanceId, backend, threadId },
  request: submission.request,
}
```

Objects sort keys by JavaScript string order; arrays preserve order; scalars use
JSON encoding; undefined object fields are omitted. No Unicode, whitespace,
path, text or settings normalization occurs. Non-finite numbers and non-JSON
values are rejected. Hash all request fields, including input attachments,
references, model/settings and provenance. Credentials are transport-only and
never request/hash fields. Server records contain hashes and receipt metadata,
not input content; error text is neither logged nor persisted by this path.

V1 is a distinct new-turn queue operation (dispatch forces `delivery: "new_turn"`).
It is not grouped agent steering. `queueEntryId` and `federationTarget` are
server/routing fields and rejected in the canonical request. A request is at
most 64 KiB of canonical UTF-8 JSON. Ephemeral `federationBlob` transfer IDs are
rejected; clients must use supported stable inline inputs/references. A file
reference hashes its reference fields, not mutable filesystem bytes; callers
that need content identity must capture a stable input rather than a mutable
path. Large durable attachment transfer needs a future content-addressed protocol.

## Explicit active-turn steering

Steering opts in separately with `durable_steer_requests_v1` and `turn_control`.
Use `backend.submitSteerRequest` / `backend.getSteerRequest`, or
`submitDurableSteerRequest(scope, submission, target?)` /
`getDurableSteerRequest(scope, lookup, target?)`. The client envelope and lookup
are otherwise the same; steering's request is **only**:

```ts
{ backend: "codex", threadId: "<thread>", expectedTurnId: "<active turn>",
  input: [{ type: "text", text: "Focus on the failing test" }] }
```

Persist the outbox operation and expected turn. Hash
`canonicalDurableSteerRequest(ownerInstanceId, submission)`, which uses
`operation: "steerTurn"`. Missing/empty expected-turn IDs, empty input,
caller-supplied `requestId`, fallback, settings and message origin are rejected.
Changing the turn on retry is a payload conflict.

The same inbox transactions claim steering before dispatch. Steering keys use a
separate operation namespace within the authenticated issuer/device scope and
share the profile-wide quota; the caller quota applies per operation. The owner
derives a stable, namespaced downstream `requestId` in receipt `queueEntryId`,
then calls existing `controlActiveTurn` with `operation: "steer"`, required
`expectedTurnId` and that ID. This reuses the existing active-turn lock,
expected-target checks and in-process request/signature dedupe. It never asks
for a new-turn fallback or grouped agent steering. Every replay still checks
current capability and destination access.

`DurableSteerReceipt` includes `operation: "steerTurn"` and
`result?: ControlActiveTurnResponse`. An `ok: true` result means accepted
interjection, recorded as `dispatched`; it does not prove that the turn has
finished or applied that instruction. Some ACP providers report disposition
`queued` for a next-turn interjection; this is provider acceptance, not a durable
PwrAgent queue receipt. Transcript/turn APIs remain the execution source.
The receipt's `queueEntryId` is a control correlation ID, not a normal queue
entry. Reconcile steer requests through the steer lookup endpoint.

An exception/lost downstream ACK becomes uncertain and is never automatically
resent. Structured `ok: false` results retain the refusal code with a fixed,
sanitized message and remain conservatively uncertain: legacy control code can
classify a provider-side error as a stale target after an ambiguous call.
Preserve the receipt and show the refusal; any changed-turn request needs an
explicit new enqueue/UUID. Regex classification is not proof of nonacceptance.
Crash, expiry, relay and ownership limits are the same as prompts.

## Receipts and reconciliation

The submission returns `DurableTurnReceipt`. Lookup uses `{ id, backend,
threadId }` and returns the current receipt or `null` for an absent/expired key.
Repeated submission returns that same authoritative receipt, including its
stored `StartTurnResponse`; transport RPC IDs are independent and may change.
Receipt lifecycle can advance between replies.

| State | Evidence and client action |
| --- | --- |
| `accepted`, no result | Inbox admission committed; provider dispatch has not been claimed. Replay with the original request can safely resume it. |
| `dispatching` | Durable claim committed before calling the queue/provider; another retry must only reconcile. |
| `accepted`, queued result | Server queue admitted the prompt, not provider acceptance. Correlate by `queueEntryId`. |
| `dispatched` | Owning queue observed start/returned the provider turn identity. Read transcript via `result.turnId`. |
| `completed` | Owner queue observed terminal/cancellation; `outcome` is completed, failed or cancelled. This means execution ended, not necessarily succeeded. |
| `uncertain` | Downstream acceptance cannot be proved or a queued entry disappeared. Never automatically dispatch it again. Inspect transcript/queue and let the operator decide. |

Existing `thread/turnQueue/updated` events contain receipt `queueEntryId` and the
real `turnId` at start. Existing transcript/replay APIs retain the actual output;
the receipt stores identities rather than duplicating transcript text. After a
stream gap, reconcile the receipt and existing transcript/queue APIs. There is
no new unrestricted event broadcast, and status polling performs no writes
except a one-time transition to uncertain.

## Admission, crash boundaries and persistence

The owner uses profile-owned `state.db`, schema version 73. An immediate
transaction checks the unique `(caller_scope, request_id)` key, payload conflict
and quotas, then inserts admission. Another immediate transaction claims only
an accepted request with no result. Receipt/claim commits use SQLite
`synchronous=FULL`, restored after each synchronous transaction. No provider or
network operation runs inside a transaction; separate database connections
cannot both claim the request. A crash before admission permits retry; a crash
after admission but before claim permits resumption from the client's outbox.

A crash after claim, whether before or after downstream acceptance, cannot be
distinguished by current provider APIs. No inspected Codex `turn/start` or ACP
path advertises a durable client-key acceptance lookup. V1 therefore never
reclaims that claim for redispatch. A claim still pending after five minutes
becomes uncertain on replay/status; a late proven start can resolve it. Provider
submission errors are conservatively uncertain, including errors that might
actually precede acceptance. Queue terminal proof survives an ACK race.

The existing desktop turn queue is in memory. If a queued receipt's entry is
missing after restart/ownership change, it becomes uncertain: it could have
started before the crash. There is no new durable prompt-content outbox at the
server. A dispatched receipt remains dispatched if terminal events were missed
during restart; transcript replay is the completion source in that case. This
is deliberate fail-closed recovery, not a claim of crash-safe eventual execution.
A future provider protocol with end-to-end key/status support can add safe
recovery; text matching cannot prove acceptance.

## Trust, forwarding and ownership

Federation authenticates the Noise peer and claimed source before handlers,
including the existing trusted relay-hop checks. Every request and replay checks
current `turn_control` and durable capability grants; the service also checks
the destination still resolves. Adapter callers must authenticate the device
and check current device/thread/machine permissions on **every** submit and get.
Runtime helpers are internal trusted APIs, not an authentication mechanism.

An adapter passes its authenticated stable scope (for example
`mobile:<device UUID>`), never a scope copied from client JSON. The owner derives
`JSON.stringify(["federation", authenticatedSourceInstanceId, callerScope ?? ""])`.
Peer-supplied device delegation stays within that peer's namespace and cannot
occupy another issuer's keys. Credentials and credential hashes are not keys.
The operation and owner are fixed by these endpoints; backend/thread/destination
are also bound into the canonical hash. Reusing an ID for another destination
in the same namespace conflicts rather than silently creating another dispatch.

Relays forward original source, UUID/hash and payload unchanged; the owner inbox
is authoritative. Lost gateway state or ACKs need no gateway outbox: the client's
outbox retries the original owner. Different routes through trusted relays can
reach the same source/owner inbox. Independent ingress authorities, databases,
or relocated owner identities do **not** share keys. Pin ingress and owner; do
not auto-discover another owner or fall back to a local submission. Failover
requires the same authority identity and receipt database; otherwise reconciliation
and explicit operator action are required. Old relays/owners cannot opt in.

## Errors and retention

`request_conflict`, `request_hash_mismatch`, `request_invalid`,
`request_too_large`, `request_expired` and `request_unsupported` require client
correction, upgrade or explicit operator action. `request_destination_unavailable`
requires restoring authorization/destination access. `request_quota_exceeded`
rejects admission before dispatch; retry the same entry after capacity is
available. Authentication/capability failures never return another caller's
receipt. A transport timeout/disconnect is not rejection: lookup/replay the
original request. `null` status does not authorize a new UUID; resubmit the
original envelope if still within its window.

Expiry is `createdAt + 7 days`, with at most five minutes future-clock tolerance.
The unchanged old envelope is rejected even after its row is pruned. UUID reuse
with a new timestamp after retention is outside the guarantee. Prune expired
rows on fresh admission; cap valid receipts at 1024 per caller and 4096 per
profile. Never evict a valid key to admit another. There are no idle timers or
per-stream writes. Expired rows can remain until another admission, but total
record count remains bounded.

Checked-in write budget `durable-turn-request` measures four commits and about
28 KiB WAL for admission, claim, result and terminal receipt in the direct
service path. Actual queue-start proof adds one boundary commit. At 100 prompts
per day, the measured four-commit path projects about 2.8 MB/day (about
28 MB/day at 1000 prompts); concurrent retries/status/stream noise add zero.
The measured production queue path is five commits/~32 KiB, or about 3.3 MB/day
at 100 prompts (33 MB/day at 1000). No heartbeat is introduced. The test fixture
owns its SQLite files.
Steering's checked-in budget is three commits (admission, claim, receipt),
~24 KiB per accepted interjection; repeated submit/status adds zero writes.

## Migration and validation

Deploy owner and relay capability support first. Add authenticated adapter
integration next, then enable client outboxes only for supported destinations.
Existing entrypoints continue using their existing queue UUID, held-turn dedupe,
review/steering keys and provider semantics. Those narrower primitives are not
substitutes for this persisted owner inbox. Active steering requires its separate
capability and the explicit durable steer API. Durable attachment blobs remain
disabled in v1 clients.

`durable-turn-request-service.test.ts` covers ACK loss/restart, concurrent
connections, canonical conflict, deliberate repeated prompts, crash boundaries,
ambiguous providers, queue lifecycle races, authorization/issuer/device scope,
expiry/quota, trusted peer forwarding and write budgets. Existing bridge/router,
queue, registry and state migration tests provide legacy regression coverage.
`durable-steer-request-service.test.ts` covers accepted-but-ACK-lost steering,
restart/crash claims, concurrent retries, expected-target conflicts, intentional
repeated instructions, sanitized refusals, authentication, forwarding,
capability negotiation, retention/quotas and its write budget.
