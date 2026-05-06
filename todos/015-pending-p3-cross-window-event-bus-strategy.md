---
status: pending
priority: p3
issue_id: "015"
tags: [code-review, architecture, ipc, learnings]
dependencies: ["002"]
---

# Decide whether to consolidate cross-window events on `broadcastAgentEvent` or keep per-channel

The past plan `2026-05-05-001-feat-thread-state-update-bus-plan.md` was emphatic: "**No new EventEmitter, no new IPC channel.** Extend the existing `AgentEvent` notification union rather than creating a parallel bus." PR #198 added a new IPC channel (`messaging:open-activity-window`) and continues to use the existing `messaging:platform-status-event` and `messaging:bindings-changed` channels.

## Problem Statement

There's an architectural tension between:

- The bus pattern (one `AgentEvent` channel, fan out to listeners)
- Per-channel events (one channel per concern, broadcast to all windows)

PR #198 didn't violate the bus pattern *per se* — `messaging:open-activity-window` is a request, not an event broadcast. But the messaging-status broadcasts (which existed pre-PR) DO operate per-channel. As secondary windows accumulate, this tension will need resolution.

## Findings

- `apps/desktop/src/main/ipc/agent-ipc.ts` — `broadcastAgentEvent` already iterates `BrowserWindow.getAllWindows()` and could host messaging-status events.
- `apps/desktop/src/main/ipc/messaging-status.ts:28-52` — `broadcastPlatformStatusEvent` and `broadcastBindingsChanged` operate independently.
- Past plan's intent was thread-state events; messaging-status events are arguably distinct because they're settings-level not thread-level.

## Proposed Solutions

### Option 1: Consolidate on `broadcastAgentEvent`

Fold messaging-status events into the `AgentEvent` union. Drop the bespoke channels. Aligns with the past plan.

**Pros:**
- One bus across the whole app.
- Future windows opt in by listening to `agent:event`.

**Cons:**
- Cross-cuts the existing messaging IPC contract; bigger surface change.

**Effort:** 4-6 hours
**Risk:** Medium

### Option 2: Keep per-channel; add scoping

(See todo #002.) Keep the channels distinct but make fan-out scoped per window.

**Effort:** 2-3 hours
**Risk:** Low

### Option 3: Document the policy

Decide explicitly: "thread-state events use `broadcastAgentEvent`; settings/messaging-status events use per-channel broadcasts." Update the plan to make the carve-out durable.

**Effort:** 30 min
**Risk:** None

## Recommended Action

(To be filled during triage.) Likely Option 3 + the scoping work in todo #002. The bus pattern works for thread-state because every consumer wants every event; messaging-status events are window-scoped by nature.

## Affected Files

- `apps/desktop/src/main/ipc/messaging-status.ts`
- `apps/desktop/src/main/ipc/agent-ipc.ts`
- `docs/plans/2026-05-05-001-feat-thread-state-update-bus-plan.md` — possibly amend

## Resources

- **PR:** #198
- **Reviewer:** learnings-researcher (cited the past plan as a contradiction)
- **Related todo:** #002

## Acceptance Criteria

- [ ] Decision documented (which events use which bus)
- [ ] Code aligned with the documented policy
- [ ] Future contributors find clear guidance

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via learnings-researcher
