---
title: "feat: route messaging to federated remote threads"
type: feat
date: 2026-06-21
status: proposed
builds-on: docs/plans/2026-06-10-001-feat-pwragent-instance-federation-plan.md
---

# feat: route messaging to federated remote threads

## Summary

The federation MVP (PR #735) added helpers to route messaging (Telegram/Discord/
etc.) to threads that live on remote PwrAgent instances, but they are **dead
code**: `federatedThreadRefForMessagingBinding`,
`messagingBindingTargetsRemoteInstance`, and
`findActiveBindingsForFederatedThread` have unit tests but **zero production
callers**. This plan wires them into a working end-to-end path so a gateway's
messaging surface can browse, bind, steer, and receive live updates from a remote
child instance's threads — fulfilling requirement R14 of the original plan.

Critically, "wire the helpers" is **not** sufficient on its own. Investigation
confirmed two missing pieces that make the helpers unreachable today, plus one
security decision:

1. **No remote threads in the browse list.** Messaging `/resume`-style browse is
   powered by `DesktopMessagingBackendBridge.getNavigationSnapshot`
   (`messaging-controller.ts:1810`, `:2252`, `:4551`), which is local-only. An
   operator can never *select* a remote thread to bind, so nothing ever creates a
   remote binding.
2. **Bindings never record the remote target.** `federatedThread` is never
   assigned anywhere in `apps/desktop/src/main/messaging/` (confirmed by grep);
   `bindChannelToThread` (`messaging-controller.ts:10452`) does not stamp it. So
   even a hypothetical remote binding would have `federatedThread === undefined`
   and `findActiveBindingsForFederatedThread` would return empty.
3. **Remote-agent control via messaging needs explicit authorization.** Routing a
   Telegram message to a child instance lets a messaging actor drive a coding
   agent on another machine. The original plan's System-Wide Impact note is
   explicit: existing actor allowlists are necessary but **not sufficient**; the
   remote peer must also allow messaging-originated operations.

---

## Problem Frame

Today, for a LOCAL bound thread, the flow is:

inbound platform event → `MessagingController` (`handleText`,
`messaging-controller.ts:1345`) → resolve binding by channel
(`findActiveBindingForChannel`) → `startPreparedInput` → `this.options.backend.*`
(the `DesktopMessagingBackendBridge`) → `BackendRegistry`.

Backend events flow back via `registry.onEvent` →
`messaging-runtime.ts:1166` → `controller.handleBackendEvent`
(`messaging-controller.ts:766`) → binding lookup by
`findActiveBindingsForThread` → status-surface refresh.

For a REMOTE thread, three things must change without leaking federation into
provider packages or `messaging/core/` (dependency-cruiser forbids both):

- The browse list must include remote threads (so a binding can be created).
- The binding must persist its `federatedThread` (so routing can target the peer).
- Outbound calls and inbound events must branch local-vs-remote.

The single legal seam for federation calls is
`apps/desktop/src/main/messaging/desktop-backend-bridge.ts` (lives in
`messaging/`, not `messaging/core/`; already imports `../app-server/*`, so it may
import `../federation/federation-runtime`). The renderer-facing IPC layer
(`agent-ipc.ts:362-369`) already implements the exact branch pattern to mirror:
`if (isRemoteFederationTarget(target)) return
getDesktopFederationRuntime().remoteBackend(target).<method>(...)`.

---

## Key Technical Decisions

- **KTD1. Branch in the bridge, stamp in the controller.** `MessagingController`
  (in `messaging/core/`) may only use `@pwragent/shared` +
  `@pwragent/messaging-interface` helpers, so it stamps `request.federationTarget`
  from `binding.federatedThread` but never calls federation runtime. The bridge
  (in `messaging/`) does the actual local-vs-remote dispatch. Keeps the
  dependency boundary intact.

- **KTD2. Reuse existing federation primitives, do not invent new transport.**
  Browse surfacing uses the already-built `remoteNavigationSnapshot`
  (`federation-runtime.ts:237`) / `FederatedSearchService` (currently dead). Each
  backend op maps 1:1 to a `FederationBackendOperations` method
  (`federation-backend-bridge.ts:91-132`) — `startTurn`, `steerTurn`,
  `interruptTurn`, `compactThread`, `submitServerRequest`, `readThread`,
  `listSkills`, etc. `readThreadStatus`/`readThreadLastAssistantReply` call remote
  `readThread` then reuse the local `findLastAssistant*` extraction.

- **KTD3. Fail-closed remote messaging authorization (the security fork).** Add a
  `messaging_route` federation capability that defaults **OFF**. A gateway only
  routes messaging to a child peer that was enrolled with `messaging_route`
  granted. With the capability absent, remote browse hides the peer's threads and
  any attempted remote route returns a safe "not authorized" surface. This gives
  a conservative default without a full multi-tenant policy engine, and keeps
  remote agent control opt-in per peer. (A richer per-actor/per-peer policy is a
  later refinement; default-off is the safe MVP.)

- **KTD4. Remote backend events reach messaging without polluting the local
  registry.** Remote events currently terminate at the renderer
  (`DesktopFederationRuntime.publishAgentEvent` → `broadcastAgentEvent`,
  `agent-ipc.ts:300`). Add a *second* federation-event consumer for messaging
  rather than funneling remote events through `registry.emit` (which would
  corrupt local registry semantics). The controller's event lookup branches to
  `findActiveBindingsForFederatedThread` when `event.federationTarget` is remote.

---

## Implementation Units

### U1. Request contracts carry a federation target

**Files:** `packages/shared/src/contracts/normalized-app-server.ts`
**Goal:** Ensure `StartTurnRequest`, `SteerTurnRequest`, `InterruptTurnRequest`,
`CompactThreadRequest`, and the other turn-control requests the bridge forwards
carry `federationTarget?: FederationTarget` (the pattern already exists on list/
handoff requests at `:491`, `:578`, `:641`, `:677`). Leaf package — boundary-safe.

### U2. `messaging_route` capability (fail-closed authorization)

**Files:** `packages/shared/src/contracts/federation.ts` (capability enum),
`apps/desktop/src/main/federation/federation-runtime.ts` (do **not** add to
`DEFAULT_CAPABILITIES`), `FederationSettings.tsx` (per-peer grant control).
**Goal:** New opt-in capability gating all messaging→remote routing. Enrollment
must be able to grant it explicitly; reconnect policy enforces it.

### U3. Surface remote threads in messaging browse

**Files:** `apps/desktop/src/main/messaging/desktop-backend-bridge.ts`
(`getNavigationSnapshot`, `:58`), reuse `remoteNavigationSnapshot` /
`FederatedSearchService`.
**Goal:** When the local instance is a gateway with `messaging_route`-granted
connected peers, merge their threads into the browse snapshot, each labeled with
the source instance (`NavigationThreadSummary.federation.instanceLabel`, already
in the contract). Per-peer deadlines; partial-failure visible; local results
always render.

### U4. Stamp `federatedThread` at bind time

**Files:** `apps/desktop/src/main/messaging/core/messaging-controller.ts`
(`bindChannelToThread`, `:10452`; callers `:2271`, `:4158`, `:5612`, `:8609`,
`:11061`).
**Goal:** When the chosen browse result is remote (carries a `FederatedThreadRef`),
persist `federatedThread` on the binding. The sqlite store already serializes the
whole binding to the `payload` column, so no schema change is needed
(`messaging-store-sqlite.ts:36-51`); `sanitizeBinding` already preserves it.

### U5. Bridge routes local-vs-remote

**Files:** `apps/desktop/src/main/messaging/desktop-backend-bridge.ts`
**Goal:** Mirror `agent-ipc.ts:362-369` in each forwarded method
(`startTurn` `:177`, `steerTurn` `:199`, `interruptTurn` `:211`, `compactThread`
`:207`, `submitServerRequest` `:257`, exec-mode/model/skills/handoff): if
`isRemoteFederationTarget(request.federationTarget)`, dispatch to
`getDesktopFederationRuntime().remoteBackend(target).<method>(...)`. Controller
stamps the target from `binding.federatedThread` (KTD1).

### U6. Remote events reach messaging controllers

**Files:** `apps/desktop/src/main/messaging/messaging-runtime.ts` /
`desktop-backend-bridge.ts` (`onEvent`, `:263`),
`apps/desktop/src/main/messaging/core/messaging-controller.ts`
(`handleBackendEvent` lookup, `:830`).
**Goal:** Add a federation-event subscription that fans remote backend events to
controllers (KTD4); branch the controller's binding lookup to
`findActiveBindingsForFederatedThread(buildFederatedThreadRef({ backend,
instanceId, threadId }))` when `event.federationTarget` is remote.
`federatedThreadIdentityKey` namespaces by `remote:<instanceId>:<backend>:
<threadId>`, so local/remote threadId collisions don't cross-match.

### U7. Tests

Mirror existing patterns: bridge local-vs-remote routing (fake federation
runtime), controller stamping + remote event lookup, capability fail-closed
(ungranted peer routes nothing), browse merge with source labels and partial
failure, degraded remote binding remains visible on disconnect. Provider package
tests must remain unchanged (callbacks stay opaque).

---

## Scope / Deferred

**In scope:** the full vertical above, with `messaging_route` default-off.
**Deferred:** per-actor (not just per-peer) remote authorization; remote
new-thread creation from messaging (no remote `startThread` protocol method
exists — see the local-only gap also reflected in the remote-window UX);
federated *content* search within messaging (this surfaces threads, not
transcript bodies).

---

## Acceptance Examples

- AE1. Operator grants `messaging_route` to child "Studio Mac", runs `/resume`
  from Telegram on the gateway, sees Studio Mac's threads labeled by source,
  binds one; the binding persists `federatedThread`.
- AE2. Sending a message to that channel steers the turn on Studio Mac, and the
  child's assistant deltas / turn status stream back to the Telegram surface.
- AE3. A child WITHOUT `messaging_route` never appears in browse and any forced
  remote route fails closed with a safe message.
- AE4. The child disconnects mid-binding: the binding stays visible but degraded;
  callbacks fail closed, not silently to a local thread.
- AE5. Provider package tests are untouched — callbacks remain opaque handles.

---

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Remote agent control granted too broadly | Messaging actor drives another machine's agent unexpectedly | `messaging_route` default-off, per-peer, fail-closed (KTD3) |
| Federation leaks into `messaging/core/` or providers | Boundary regression | Branch only in the bridge; controller uses shared helpers only (KTD1); run `pnpm lint:boundaries` |
| Remote events corrupt local registry | Local thread state desync | Separate federation-event consumer, never `registry.emit` (KTD4) |
| Bindings created before this change have no `federatedThread` | Silent no-op routing | They are local bindings by definition; only new remote binds get stamped |

---

## Sources

- Recon of the dead helpers, bind path, and event flow (this branch).
- `apps/desktop/src/main/messaging/desktop-backend-bridge.ts` (the seam).
- `apps/desktop/src/main/ipc/agent-ipc.ts:362-369` (the branch pattern to mirror).
- `apps/desktop/src/main/federation/federation-runtime.ts` (`remoteBackend`,
  `remoteNavigationSnapshot`, `publishAgentEvent`).
- Original plan R14 + System-Wide Impact:
  `docs/plans/2026-06-10-001-feat-pwragent-instance-federation-plan.md`.
