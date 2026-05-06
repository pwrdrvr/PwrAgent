---
status: pending
priority: p2
issue_id: "002"
tags: [code-review, architecture, ipc, electron, multi-window]
dependencies: []
---

# Scope IPC fan-out so windows only receive events they care about

`broadcastPlatformStatusEvent` and `broadcastBindingsChanged` use `BrowserWindow.getAllWindows()` to fan messaging events out to every window. With the activity window now in play, every messaging event is serialized + IPC'd + deserialized in BOTH render processes, even when the receiving window doesn't subscribe to that channel.

## Problem Statement

`apps/desktop/src/main/ipc/messaging-status.ts:28-52` blasts events to every BrowserWindow. The activity window receives bindings-changed events it doesn't care about (the Activity surface only listens to its own polling). This compounds:

- Cost grows linearly with secondary windows.
- A future window that *should* opt out has no way to.
- DevTools detached windows in some Electron versions also receive the broadcasts.

## Findings

- `apps/desktop/src/main/ipc/messaging-status.ts:28-52` — `getAllWindows()` fan-out, no filtering.
- Past plan `2026-05-05-001-feat-thread-state-update-bus-plan.md` lines 14, 119–132, 219, 230 advocates the OPPOSITE pattern: "**No new EventEmitter, no new IPC channel.** Extend the existing `AgentEvent` notification union." The bus pattern was designed precisely so cross-surface receivers stay in sync without per-surface fan-out.

## Proposed Solutions

### Option 1: Subscription registry per channel

**Approach:** Maintain `Map<channel, Set<WebContents>>`. Each window registers its interest on `did-finish-load` (via a renderer-side IPC handshake) and unregisters on `closed`/`destroyed`. Broadcasters iterate only the registered set for their channel.

**Pros:**
- Surgical — each window pays only for what it consumes.
- Pattern scales cleanly to N windows.

**Cons:**
- New handshake protocol; renderer needs to opt in.

**Effort:** 2-3 hours
**Risk:** Medium (handshake timing)

### Option 2: Per-window tag check

**Approach:** Tag each window's `webContents` with metadata at creation time (`(webContents as any).__pwragentChannels = new Set([...])`). Broadcasters skip windows that don't have the channel in their tag.

**Pros:**
- Minimal protocol — main process owns the metadata.
- Easy to audit at the spawn site.

**Cons:**
- Type-shim required; main-process-only knowledge of which window cares about what.

**Effort:** 1-2 hours
**Risk:** Low

### Option 3: Reuse `broadcastAgentEvent` and the existing `AgentEvent` union

**Approach:** Per the past plan's guidance, fold messaging-status events into `AgentEvent` and route through the existing renderer subscription. Drop the bespoke `messaging:platform-status-event` channel.

**Pros:**
- Strongest architectural alignment — one bus, not two.
- Future windows opt in by listening to `agent:event`.

**Cons:**
- Cross-cuts the messaging IPC contract; bigger surface change.
- Past plan's intent was thread-state events; messaging-status events are arguably distinct.

**Effort:** 4-6 hours
**Risk:** Medium

## Recommended Action

(To be filled during triage.) Option 2 is the smallest fix with immediate value. Option 1 if a third window lands soon.

## Technical Details

**Affected files:**
- `apps/desktop/src/main/ipc/messaging-status.ts:28-52` — broadcast functions
- `apps/desktop/src/main/messaging-activity-window.ts` — tag the window at creation
- `apps/desktop/src/main/window.ts` — tag the main window at creation

## Resources

- **PR:** #198
- **Reviewer:** architecture-strategist — C1
- **Past plan to align with:** `docs/plans/2026-05-05-001-feat-thread-state-update-bus-plan.md`

## Acceptance Criteria

- [ ] Activity window doesn't receive `messaging:bindings-changed` (it doesn't subscribe)
- [ ] Activity window does receive `messaging:platform-status-event` (it might subscribe in future, OR it currently relies on polling — confirm during triage)
- [ ] Pattern scales to N windows without per-broadcast plumbing changes
- [ ] No regression in main-window receipt of these events

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via architecture-strategist agent
