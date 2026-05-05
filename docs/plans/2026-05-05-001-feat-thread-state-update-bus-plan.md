---
title: "feat(messaging): thread-state update bus for cross-surface synchronization"
type: feat
status: active
date: 2026-05-05
---

# Thread-State Update Bus for Cross-Surface Synchronization

## Overview

Today, when the user toggles permission mode (or model, reasoning, fast mode) from a Discord status card, only Discord re-renders. The desktop app and any active Telegram status surface keep showing the stale value until the next manual refresh. This plan generalizes the existing approval-clear pattern so that any thread-state mutation — regardless of which surface initiated it — propagates to every other live surface bound to that thread.

The mechanism already exists in skeleton form. `BackendRegistry.eventListeners` is a single in-process emitter with two fan-out branches: renderer (IPC `agent:event`) and messaging controllers (`messaging-runtime.ts` → `handleBackendEvent`). The only thread-state-change notification today that actually rides this bus and triggers cross-surface clearing is `serverRequest/resolved`, which clears approval buttons across every binding via `findActivePendingIntentsForRequest` + `retireApprovalIntent`. We need the same shape for ordinary thread-state mutations.

This plan ships:

1. New typed `AppServerNotification` methods for thread-state mutations.
2. Backend-registry emissions on every mutating method (success path).
3. A generic per-controller helper that refreshes status surfaces for all bindings of a thread on receipt of a thread-state notification.
4. Renderer subscriptions that patch the navigation snapshot in place (or trigger `scheduleRefresh`) on the same notifications.
5. AGENTS.md guidance describing the bus so future feature authors don't re-invent ad-hoc sync.

## Problem Statement / Motivation

**Concrete bug**: From the live Discord/Telegram session that motivated this plan, clicking "Permissions" in Discord changed Discord's status card to "Default Access" but neither the desktop app nor the Telegram status card reflected the change. Users running multi-surface workflows experience drift between what each surface shows and what the agent will actually do on the next turn.

**Underlying gap**: Thread-state mutations have three independent code paths:

- IPC handlers in `apps/desktop/src/main/ipc/agent-ipc.ts` (called from the desktop UI) — call `registry.setThreadExecutionMode`, return the response, do nothing else.
- Messaging callback handlers in `apps/desktop/src/main/messaging/core/messaging-controller.ts` (called from Telegram/Discord buttons) — call `registry.setThreadExecutionMode`, then refresh **only the calling binding's** status card.
- The Codex/Grok backends themselves, which are the canonical source of truth.

None of these paths emit a notification on the registry's emitter. That's what blocks fan-out.

**Why approvals work but settings don't**: Approvals work because the agent's tool-call resolution path (`submitServerRequest`) is wired to `this.emit({ method: "serverRequest/resolved", ... })` at `backend-registry.ts:1973-1983`. The mutation paths for execution mode and model settings have no equivalent emit.

## Proposed Solution

Build on the existing emitter rather than introducing a new bus. Three pieces:

### 1. Notification surface — extend `AppServerNotification`

Add granular event methods that mirror the existing convention (`thread/name/updated`, `thread/archived`):

```ts
// packages/shared/src/contracts/normalized-app-server.ts

| { method: "thread/executionMode/updated";
    params: { threadId: ThreadIdentifier; executionMode: ThreadExecutionMode } }

| { method: "thread/modelSettings/updated";
    params: {
      threadId: ThreadIdentifier;
      model?: string;
      fastMode?: boolean;
      reasoningEffort?: string;
      serviceTier?: string;
    } }
```

`thread/compacted` already exists. `thread/handoff/completed` and conversation-rename events are deferred (workspace handoff currently triggers a full navigation refresh on the renderer side via `turn/completed`; conversation rename is binding-scoped and listed under deferred binding-pref events below).

### 2. Emit from the backend registry (single emit point per mutation)

In `apps/desktop/src/main/app-server/backend-registry.ts`:

- `setThreadExecutionMode` (`backend-registry.ts:1800-1831`) — emit `thread/executionMode/updated` after `overlayStore.setThreadExecutionMode` succeeds.
- `setThreadModelSettings` (`backend-registry.ts:1833-1852`) — emit `thread/modelSettings/updated` after the overlay write.

These run in the same in-process emitter that already feeds `serverRequest/resolved` and `thread/name/updated`. No new infrastructure.

### 3. Subscribe in messaging controllers and the renderer

**Messaging controllers** (`apps/desktop/src/main/messaging/core/messaging-controller.ts`):

Add a generic helper next to `handleBackendRequestResolved`:

```ts
private async refreshStatusSurfacesForThread(
  backend: AppServerBackendKind,
  threadId: ThreadIdentifier,
  reason: string,                          // for logs/audit only
): Promise<void> {
  const bindings = this.filterBindingsForChannel(
    await this.options.store.findActiveBindingsForThread({
      backend, threadId, now: this.now(),
    }),
  );
  for (const binding of bindings) {
    if (binding.statusSurface || binding.pinnedStatusSurface) {
      await this.renderBindingStatus(binding, undefined);
    }
  }
}
```

In `handleBackendEvent` (line ~272), branch on the new methods and call the helper. `renderBindingStatus` already pulls a fresh navigation snapshot, so the new permissionsMode/model values will be reflected.

**Renderer** (`apps/desktop/src/renderer/src/lib/useThreadNavigation.ts`):

In the `onAgentEvent` handler (lines 1095-1195), add branches mirroring `thread/name/updated`:

```ts
if (method === "thread/executionMode/updated") {
  applyThreadExecutionModeUpdate(snapshot, params);  // existing optimistic helper, lifted/extended
}
if (method === "thread/modelSettings/updated") {
  applyThreadModelSettingsUpdate(snapshot, params);  // already exists at lines 424-461
}
```

The optimistic helpers used today on the IPC mutation path already mutate the snapshot in place. Reuse them on the push path. No new helpers required for `modelSettings`; for `executionMode` we add one parallel helper (or generalize `applyThreadModelSettingsUpdate`).

### 4. AGENTS.md guidance

Add a short section to both `apps/desktop/AGENTS.md` and `packages/messaging/AGENTS.md` titled **"Thread-state update bus"** that says, in essence:

> Any code that mutates persistent thread state (model, reasoning, permissions, name, workspace) MUST emit a typed `AppServerNotification` from the registry mutation method. This is what keeps Telegram, Discord, and the desktop UI in sync. The cross-surface refresh is automatic — controllers and the renderer subscribe to the existing in-process emitter (`backend-registry.ts:eventListeners`) and resolve their own surfaces. Do not add ad-hoc IPC channels or per-controller refresh fan-outs; extend the notification union and let the bus do the work.

## Technical Considerations

- **No new EventEmitter, no new IPC channel.** This is a deliberate choice. We extend the existing `AgentEvent` notification union rather than creating a parallel "messaging bus" or "thread-state bus." The single-broadcast / topic-multiplexed pattern is established (renderer's `agent:event` channel, messaging-runtime's `onEvent`).
- **Granular events, not coarse.** `thread/executionMode/updated` rather than a generic `thread/state/changed` with a "what-changed" payload. Matches the existing `thread/name/updated` precedent and lets each subscriber pattern-match without parsing payload diffs.
- **No `source` field on events.** The first instinct was to add `source: "desktop" | "messaging:discord" | ...` to suppress self-refresh. Skipped — `renderBindingStatus` is idempotent and the cost of one extra render after your own click is trivial. Keep events minimal.
- **Idempotency on receipt.** The bus may deliver the same notification twice (already fan-out via two listeners). Each subscriber's handler must be idempotent. `renderBindingStatus` already is; the renderer's `applyThread*Update` helpers already are (they no-op if values match).
- **Failure isolation.** A failing controller refresh must not block other controllers or the renderer. The existing `Promise.all` over controllers in `messaging-runtime.ts:144-165` already wraps each controller in its own try/catch. Preserve this pattern in the new helper.
- **Binding-scoped state stays out of scope.** `toolUpdateMode` and other `MessagingBindingRecord.preferences` values are per-binding, not per-thread. Deferred until there's an actual user-facing reason to sync them across bindings (the desktop app does not display per-binding tool-update mode today). Documented as a follow-up.

## System-Wide Impact

- **Interaction graph**: `setThreadExecutionMode` (registry) → `overlayStore.setThreadExecutionMode` → `this.emit({ method: "thread/executionMode/updated", ... })` → (a) `broadcastAgentEvent` → renderer `useThreadNavigation` snapshot patch; (b) `messaging-runtime.onEvent` → each `MessagingController.handleBackendEvent` → `refreshStatusSurfacesForThread` → `renderBindingStatus` per binding → `adapter.deliver` with `delivery.mode = "update"` → provider edits the existing message.
- **Error propagation**: A registry-level emit failure is silent today (the emitter swallows listener errors per `eventListeners.forEach` semantics). Verify that pattern. Renderer-side errors don't propagate back; controller-side errors are logged via `messagingLog.error` in the existing `handleBackendEvent` catch block.
- **State lifecycle risks**: A user toggles permissions in Discord; the Discord click handler currently calls `setThreadExecutionMode` THEN `renderBindingStatus` for its own binding. After this change, the bus also re-renders Discord's status (because Discord is a subscriber). Net result: Discord renders twice in quick succession. Mitigation options: (a) accept the double render — cheap, idempotent; (b) drop the Discord-side `renderBindingStatus` call now that the bus handles it. **Decision**: Drop the per-handler `renderBindingStatus` call from each messaging callback handler (`togglePermissionsMode`, `setBindingModel`, etc.) since the bus will handle refresh. This makes the bus the single source of refresh and matches the pattern in `handleBackendRequestResolved`.
- **API surface parity**: Renderer mutation IPC handlers (`agent:set-thread-execution-mode`, `agent:set-thread-model-settings`) currently rely on the renderer's own optimistic update for instant UI feedback. After this change, the same renderer also receives a push notification for its own mutation. Both paths converge on `applyThread*Update` helpers, which are idempotent. Verify no double-toast or double-animation occurs.
- **Integration test scenarios**:
  1. Discord user clicks Permissions → Telegram status surface re-renders with the new value within one event tick.
  2. Telegram user clicks Model picker → Discord status surface re-renders; desktop UI's `useThreadNavigation` snapshot updates without a full refetch.
  3. Desktop user toggles permission mode → Discord and Telegram both re-render.
  4. Two surfaces toggle in rapid succession (race) → both end states are eventually consistent (final emitted value wins).
  5. A controller fails to refresh (e.g., adapter offline) → other controllers and renderer still update.

## Acceptance Criteria

- [ ] `AppServerNotification` includes `thread/executionMode/updated` and `thread/modelSettings/updated` method variants with strongly typed `params`.
- [ ] `BackendRegistry.setThreadExecutionMode` emits `thread/executionMode/updated` after a successful overlay write.
- [ ] `BackendRegistry.setThreadModelSettings` emits `thread/modelSettings/updated` after a successful overlay write.
- [ ] `MessagingController.handleBackendEvent` routes both new methods to `refreshStatusSurfacesForThread`.
- [ ] `refreshStatusSurfacesForThread` finds all active bindings for the affected `(backend, threadId)` filtered to the controller's channel and re-renders each binding's status surface.
- [ ] Each messaging callback handler (`togglePermissionsMode`, `setBindingModel`, `setBindingReasoning`, `toggleFastMode`) drops its inline `renderBindingStatus` call — the bus is the single refresh source.
- [ ] `useThreadNavigation` adds handler branches for both methods, reusing `applyThreadModelSettingsUpdate` and a parallel `applyThreadExecutionModeUpdate`.
- [ ] `apps/desktop/AGENTS.md` and `packages/messaging/AGENTS.md` each have a "Thread-state update bus" section pointing future authors at the pattern.
- [ ] Unit tests cover: registry emits new notifications; controller refreshes other bindings on event receipt; renderer applies updates without full refetch.
- [ ] Manual cross-surface verification (matrix of Discord → Telegram, Telegram → Discord, desktop → messaging, messaging → desktop) all reflect changes within one event tick.

## Implementation Units

> Each unit is sized for an independent commit. Verification is the "done" signal for that unit.

### Unit 1: Notification union extension

- **Goal**: Add `thread/executionMode/updated` and `thread/modelSettings/updated` variants to `AppServerNotification`.
- **Files**: `packages/shared/src/contracts/normalized-app-server.ts` (around line 522-893 where the union lives), corresponding shape exports in any duplicated declarations under `packages/codex-app-server-protocol/`.
- **Approach**: Extend the union; add `params` shapes that mirror the registry mutation method signatures. No emit yet.
- **Patterns to follow**: existing `thread/name/updated` (line 779) and `thread/compacted` (line 786) shape for naming and field discipline.
- **Verification**: `pnpm typecheck` clean.

### Unit 2: Registry emits on success

- **Goal**: Emit the two new notifications on successful mutation in the registry.
- **Files**: `apps/desktop/src/main/app-server/backend-registry.ts` — `setThreadExecutionMode` (line 1800-1831), `setThreadModelSettings` (line 1833-1852).
- **Approach**: Call `this.emit({ backend, notification: { method, params } })` after the overlay write succeeds. Mirror the emit pattern at line 1973-1983 (`submitServerRequest` → `serverRequest/resolved`).
- **Patterns to follow**: `submitServerRequest`'s emit shape; existing emit-after-overlay in `archiveThread` if present.
- **Verification**: New unit test: register a listener, call `setThreadExecutionMode`, assert listener received the notification with correct shape.

### Unit 3: Generic cross-binding refresh helper

- **Goal**: Lift the cross-binding refresh pattern out of `handleBackendRequestResolved` into a reusable helper.
- **Files**: `apps/desktop/src/main/messaging/core/messaging-controller.ts`.
- **Approach**: Add private `refreshStatusSurfacesForThread(backend, threadId, reason)`. Refactor `handleBackendRequestResolved` to use the helper for the surface-refresh part (it still has approval-specific logic for retiring intents — keep that separate).
- **Patterns to follow**: existing `handleBackendRequestResolved` (`messaging-controller.ts:1156-1182`) for binding lookup + filter pattern.
- **Verification**: Existing approval-clear tests still pass; new unit test directly invokes helper and asserts each binding's status surface is re-rendered.

### Unit 4: Wire bus → messaging controllers

- **Goal**: `handleBackendEvent` routes the new notification methods to the helper; remove redundant per-handler refreshes.
- **Files**: `apps/desktop/src/main/messaging/core/messaging-controller.ts`.
- **Approach**: In `handleBackendEvent` (~line 272), add branches `if (method === "thread/executionMode/updated" || method === "thread/modelSettings/updated") return this.refreshStatusSurfacesForThread(...)`. Drop the inline `renderBindingStatus` from `togglePermissionsMode` (line ~2450), `setBindingModel` (~2385), `setBindingReasoning` (~2409), `toggleFastMode` (~2428). They still update binding preferences locally.
- **Patterns to follow**: `serverRequest/resolved` branch already in `handleBackendEvent` at line 272-275.
- **Execution note**: This is the unit most likely to break existing tests. After dropping inline refreshes, the test harness needs to ensure the registry emits the new notification (which the helper consumes). Run controller tests after each handler is updated, not in batch.
- **Verification**: All `messaging-controller.test.ts` tests pass; specifically the tests that assert "after togglePermissionsMode, the status card is re-rendered" — which should now pass via the bus path with a mocked emitter.

### Unit 5: Renderer subscribes and patches snapshot

- **Goal**: Renderer reflects state changes pushed from the bus, including changes initiated by Telegram/Discord.
- **Files**: `apps/desktop/src/renderer/src/lib/useThreadNavigation.ts`.
- **Approach**: Add handler branches for the two new methods (alongside `thread/name/updated` at lines 1095-1195). Reuse `applyThreadModelSettingsUpdate` (already at lines 424-461) for one branch; add a parallel `applyThreadExecutionModeUpdate` for the other.
- **Patterns to follow**: `applyThreadModelSettingsUpdate` (existing helper) and the optimistic-then-refresh pattern at lines 1917-1967.
- **Verification**: New renderer test: mock `desktopApi.onAgentEvent`, dispatch the two new notifications, assert the snapshot reflects the new values without a `getNavigationSnapshot` re-fetch.

### Unit 6: AGENTS.md documentation

- **Goal**: Document the bus pattern so future authors extend it correctly.
- **Files**: `apps/desktop/AGENTS.md`, `packages/messaging/AGENTS.md`.
- **Approach**: Add a "Thread-state update bus" section to each. Keep it short — one paragraph per file, plus a pointer to the registry emit point and the controller subscriber. Cross-link.
- **Verification**: The doc explains: (a) when to add a new notification, (b) where to emit, (c) where consumers subscribe, (d) the rule that no ad-hoc IPC channels or per-controller refreshes are added for thread-state-changes.

## Deferred to Implementation

- **Whether the messaging callback handlers should also clear their inline `renderBindingStatus` for actions that don't go through the registry** (e.g., `cycleToolUpdateMode` writes only to the binding record, no registry emit). For binding-only mutations, the inline refresh stays — it's the only thing keeping that surface fresh. Decision: drop inline refresh ONLY for handlers whose mutation path now emits a thread-state notification. Keep it for binding-only mutations.

- **Whether `applyThreadExecutionModeUpdate` should be a new helper or fold into `applyThreadModelSettingsUpdate`'s shape**. Decide at edit time based on what the existing helper signature accepts.

## Scope Boundaries

- Binding-scoped events (e.g., `toolUpdateMode` cross-binding sync) are NOT in scope. If the desktop UI never displays per-binding preferences, there's no observable drift — no need to fan out.
- Workspace handoff completion notifications (`thread/handoff/completed`) are NOT in scope. The existing `turn/completed` notification + navigation re-pull already covers it.
- Conversation-rename (messaging-side chat title) is NOT in scope. It's binding/channel-scoped.
- New `AgentEvent` channel beyond `agent:event` is explicitly out of scope. The single-broadcast pattern is the established convention.
- Multi-tenant or cross-process bus (e.g., for a future server build) is out of scope. The registry-level emitter is in-process by design.

## Sources & References

### Internal references

- Existing approval propagation:
  - `apps/desktop/src/main/app-server/backend-registry.ts:1962-1991` (`submitServerRequest` + emit)
  - `apps/desktop/src/main/messaging/core/messaging-controller.ts:1156-1182` (`handleBackendRequestResolved`)
  - `apps/desktop/src/main/messaging/messaging-runtime.ts:144-165` (controller fan-out)
  - `apps/desktop/src/main/ipc/agent-ipc.ts:154-179` (renderer fan-out)

- Mutation entry points:
  - `apps/desktop/src/main/app-server/backend-registry.ts:1800-1852` (`setThreadExecutionMode`, `setThreadModelSettings`)
  - `apps/desktop/src/main/ipc/agent-ipc.ts:328-348` (IPC handlers — currently silent)
  - `apps/desktop/src/main/messaging/core/messaging-controller.ts:2364-2477` (status callback handlers)

- Status surface producer:
  - `apps/desktop/src/main/messaging/core/messaging-status-card.ts:30-178` (`buildBindingStatusIntent`)

- Notification union:
  - `packages/shared/src/contracts/normalized-app-server.ts:522-893` (existing methods including `thread/name/updated`, `thread/compacted`, `serverRequest/resolved`)

- Renderer subscription:
  - `apps/desktop/src/renderer/src/lib/useThreadNavigation.ts:1095-1195` (`onAgentEvent` handler)
  - `apps/desktop/src/renderer/src/lib/useThreadNavigation.ts:424-461` (`applyThreadModelSettingsUpdate`)
  - `apps/desktop/src/preload/index.ts:339-346` (`onAgentEvent` bridge)

### Conventions

- `apps/desktop/AGENTS.md`, `packages/messaging/AGENTS.md`, root `AGENTS.md` — package boundaries, channel-neutral workflow rules, no provider conditionals in shared logic.

### Related work

- PR #180 (capability discovery and adaptive rendering) — same controller-per-adapter architecture this plan extends.
