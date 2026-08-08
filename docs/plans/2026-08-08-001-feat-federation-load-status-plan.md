# Federation on-demand load status

- **Date:** 2026-08-08
- **Type:** feat
- **Scope:** desktop (federation), shared contracts
- **Builds on:** PR #1248 / [2026-08-05-003-feat-federation-agent-tools-plan.md](2026-08-05-003-feat-federation-agent-tools-plan.md),
  whose "Follow-up round" section deliberately deferred live load signals
  to a query-on-demand follow-up and shaped `FederationHostInfo` so a
  `load` sibling could join later. This is that follow-up.

## Problem

`FederationHostInfo` advertises static host facts (CPU count, total RAM,
a disk-free snapshot) on handshake, but nothing answers "how busy is that
instance *right now*?" Placement decisions ("find me a place to run
this") and the Star Map's per-instance health indicators (low RAM, high
CPU, low disk) need a live reading. Broadcasting it was rejected in the
prior round: load changes constantly, so gossiping it either spams the
mesh or serves stale numbers. It is a query-on-demand concern.

## Decision

One simple query RPC, no gossip, no caching layer:

- **`backend.getLoadStatus`** joins `FEDERATION_BACKEND_METHODS` in
  `federation-backend-bridge.ts`. Zero-argument request; the response is
  a `FederationLoadStatus` sampled at answer time on the owning instance:

  ```ts
  type FederationLoadStatus = {
    loadAvg1: number;   // os.loadavg() — 0 on Windows, by Node contract
    loadAvg5: number;
    loadAvg15: number;
    availableMemoryBytes: number; // os.freemem()
    freeDiskBytes?: number;       // fs.statfs on the PwrAgent root; omitted on failure
    sampledAt: number;
  };
  ```

  The type lives in `packages/shared/src/contracts/federation.ts` as a
  **sibling** of `FederationHostInfo`, per the prior round's shaping —
  host stays static facts, load stays live readings; neither extends the
  other.

- **Capability: `thread_navigation`.** A load reading is a read-only
  health fact at the same sensitivity tier as the browse-level grants;
  the Star Map's `star_map` event class already rides
  `thread_navigation`, and `setCelestialIcon` set the precedent that
  federation-level non-thread state uses the least-privileged grant
  every browsing peer already holds. A new capability was considered and
  rejected: it would buy no isolation (the data is less sensitive than
  thread titles) and would cost a handshake-advertisement round for
  every peer.

- **Sampling** lives in `collectFederationLoadStatus` beside
  `collectFederationHostInfo` in `federation-host-info.ts` — same
  `fs.statfs`-on-the-PwrAgent-root pattern for disk, `os.loadavg()` +
  `os.freemem()` for CPU/RAM. The local instance (including a gateway
  answering for itself) samples directly via `localBackendOperations()`;
  relayed peers are reached through the existing envelope relay exactly
  like every other backend RPC — no special routing.

- **Tight timeout, degrade to absence.** The remote client passes
  `timeoutMs: 2_500` (`FEDERATION_LOAD_STATUS_TIMEOUT_MS`) instead of
  the 30s default. Every caller treats a timeout/error as "no `load`
  block", never as a failed listing.

## Callers

1. **`list_federation_instances`** gains `includeLoad?: boolean` —
   additive optional input only, per the agent-tool contract rules in
   `apps/desktop/src/main/agent-tools/AGENTS.md`. When true, the handler
   fans `getLoadStatus` out concurrently to the local instance plus every
   *connected* peer that granted `thread_navigation`, and attaches the
   result as a `load` sibling next to each descriptor's `host` block.
   Peers that fail or time out simply omit `load`. Continuation-cursor
   pages serve the loads captured when the listing was built (bounded by
   the existing ~60s cursor TTL, which is exactly the staleness budget a
   token-paged listing already accepts). The tool description documents
   the machineId rule: instances sharing `host.machineId` report the
   same underlying load — dedupe by machineId when aggregating for
   placement decisions, never sum.

2. **Star Map health indicators** poll a new renderer-facing IPC
   channel, `federation:read-instance-load`
   (`readFederationInstanceLoad(request?: { instanceId? })` on
   `desktopApi`). Omitted/local instanceId samples locally; a remote id
   routes through `runtime.remoteBackend`. Not-connected peers,
   missing capability, and RPC failures all return `{}` (no `load`) —
   a polling health surface wants a missing indicator, not an error
   dialog. The rendering side (indicator thresholds, visuals) lands on
   the Star Map branch; this branch provides the query surface only.

## Addition (same branch): per-peer wire-transfer counters

Decided with the operator after the load-status round landed: to
baseline federation bandwidth before an envelope-compression change
(and verify the change after), each instance counts its own wire
traffic per directly connected peer. These are **local observations of
the protocol, not protocol fields** — nothing new crosses the wire:

- `sendFrame`/the envelope receive loops in `federation-transport.ts`
  report each envelope frame's **post-encryption byte length** through
  new `onEnvelopeTransfer` taps (gateway per-connection, client
  per-socket). Handshake/auth frames and WebSocket keepalives are not
  counted. Counting post-encryption means a compression PR moves these
  numbers by exactly its real wire savings.
- A process-local `FederationTransferLedger` in the runtime accumulates
  `FederationTransferStats` (`bytesSent/bytesReceived`,
  `envelopesSent/envelopesReceived`, `since`, `lastActivityAt`) per
  peer, across reconnects, reset only on app restart. Never persisted.
- `FederationPeerSummary.transfer` carries the snapshot on
  health/diagnostics reads only — deliberately NOT attached in
  `visiblePeers()`, which also feeds the gossiped peer directory; the
  numbers describe the observer's socket, not the peer.
- Attribution: a gateway sees true per-peer figures (relayed sibling
  traffic counts on both legs, which is wire-truthful); a client sees
  everything on the gateway's row because all its remote traffic rides
  that one socket.
- Surface: the Settings → Federation peer rows render
  "Transferred ↑ x · ↓ y across N envelopes since <t>".

## Non-goals

- No broadcast/gossip of load, no push events, no history/persistence.
- No new federation capability.
- No renderer UI in this branch.

## Touched files

- `packages/shared/src/contracts/federation.ts` — `FederationLoadStatus`,
  `ReadFederationInstanceLoadRequest/Response`.
- `packages/shared/src/contracts/federation-tools.ts` — `includeLoad`
  arg, `load` on `FederationInstanceDescriptor`.
- `apps/desktop/src/main/federation/federation-host-info.ts` — sampler.
- `apps/desktop/src/main/federation/federation-backend-bridge.ts` —
  method, capability, operations entry, handler, remote client + timeout.
- `apps/desktop/src/main/federation/federation-runtime.ts` — local
  backend operation.
- `apps/desktop/src/main/federation/federation-agent-tools-service.ts` —
  `includeLoad` fan-out.
- `apps/desktop/src/main/agent-tools/pwragent-federation-agent-tools.ts`
  — schema, normalization, description.
- `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/main/ipc/federation.ts`,
  `apps/desktop/src/preload/index.ts`,
  `apps/desktop/src/renderer/src/lib/desktop-api.ts` — IPC surface.
- Tests: `federation-host-info.test.ts`,
  `federation-backend-bridge.test.ts`,
  `federation-agent-tools-service.test.ts`,
  `agent-tools/__tests__/pwragent-federation-agent-tools.test.ts`.

## Progress

- [x] Plan doc
- [x] Shared contracts (`FederationLoadStatus`, tool args, IPC types)
- [x] Sampler + bridge RPC + local backend operation
- [x] `list_federation_instances` `includeLoad` fan-out
- [x] Renderer IPC surface for Star Map polling
- [x] Per-peer wire-transfer counters (transport taps, ledger, health,
      Settings peer rows)
- [x] Tests green (lint:eslint, typecheck, lint:boundaries, focused vitest)
