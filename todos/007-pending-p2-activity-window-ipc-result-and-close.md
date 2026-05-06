---
status: pending
priority: p2
issue_id: "007"
tags: [code-review, agent-native, multi-window, ipc, messaging-activity]
dependencies: []
---

# Make `messaging:open-activity-window` return a structured result + add a close primitive

`showMessagingActivityWindow()` returns void; the IPC handler is fire-and-forget. There's no way for a caller (renderer or future agent tool) to know whether the window was just spawned vs. already open, or to close it programmatically. The renderer doesn't need this today — but agent-native tooling will, and the cost to bake it in now is tiny.

## Problem Statement

`apps/desktop/src/shared/ipc.ts:43-51` doc-comments the channel as "fire-and-forget" but it's actually `ipcMain.handle` (returns Promise). `apps/desktop/src/main/messaging-activity-window.ts:15-78` returns void.

When agent tooling lands (e.g. an MCP server wrapping the existing IPC handlers), every "open something" tool wants to return a structured result so the agent can:
- Decide whether to follow up (was it newly opened or already focused?)
- Reference the window (windowId for inspection or close)

And every "open" tool needs a matching "close" — the activity window has only OS traffic-light close today, which means an agent can open the window for inspection but can't put it back.

## Findings

- `messaging-activity-window.ts:15-78` — `showMessagingActivityWindow()` returns void.
- `messaging-status.ts:113-116` — IPC handler ignores arguments, returns void.
- Preload binding (`apps/desktop/src/preload/index.ts:369-371`) invokes with no arguments and resolves to `void`.
- DesktopApi type `apps/desktop/src/renderer/src/lib/desktop-api.ts:230` types it as `Promise<void>`.
- `agent-native-reviewer` flagged this as the "worse seed" — tomorrow's tool wrapper inherits this contract.

## Proposed Solutions

### Option 1: Return structured result + add close primitive

**Approach:**

```ts
// messaging-activity-window.ts
export interface MessagingActivityWindowOpenResult {
  opened: boolean;       // true if a new window was created
  alreadyOpen: boolean;  // true if focus shifted to an existing window
  windowId: number;
}

export function showMessagingActivityWindow(): MessagingActivityWindowOpenResult { ... }
export function closeMessagingActivityWindow(): { closed: boolean } { ... }
```

New IPC channel `MESSAGING_CLOSE_ACTIVITY_WINDOW_CHANNEL` mirroring open. Update preload + DesktopApi.

**Pros:**
- Symmetric open/close.
- Future agent tool wrapper inherits a clean primitive contract.
- Renderer doesn't have to call close — it's there for agent + tests.

**Cons:**
- Slightly larger PR / more code.
- "fire-and-forget" doc comment in `ipc.ts` needs updating.

**Effort:** 1 hour
**Risk:** Low

### Option 2: Just return the result; defer close

**Approach:** Add the `MessagingActivityWindowOpenResult` shape now. Skip close primitive until agent tooling actually needs it.

**Pros:**
- Smaller change.

**Cons:**
- Asymmetry between open/close persists.

**Effort:** 30 min
**Risk:** Low

### Option 3: Defer entirely

Leave as-is. Refactor when agent tooling lands.

**Effort:** 0
**Risk:** Low — but the refactor moment is in a hot file.

## Recommended Action

(To be filled during triage.) Option 1 if agent tooling is on the roadmap; Option 3 if not.

## Technical Details

**Affected files:**
- `apps/desktop/src/main/messaging-activity-window.ts` — return structured result, add close
- `apps/desktop/src/main/ipc/messaging-status.ts:113-116` — propagate result; register close handler
- `apps/desktop/src/shared/ipc.ts:43-51` — update doc comment, add close channel
- `apps/desktop/src/preload/index.ts:369-371` — propagate result; add close binding
- `apps/desktop/src/renderer/src/lib/desktop-api.ts:230` — type the new result + close

## Resources

- **PR:** #198
- **Reviewer:** agent-native-reviewer — P2 finding #4

## Acceptance Criteria

- [ ] `showMessagingActivityWindow` returns `{ opened, alreadyOpen, windowId }`
- [ ] (Option 1) `closeMessagingActivityWindow` exists and works
- [ ] IPC channel doc-comment is accurate (drop "fire-and-forget" if `ipcMain.handle`-based)
- [ ] Renderer chip-click still works (regression-tested)
- [ ] Future agent tool wrapper has a clean contract

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via agent-native-reviewer
