---
status: pending
priority: p3
issue_id: "011"
tags: [code-review, architecture, multi-window, electron]
dependencies: ["002"]
---

# Introduce a `WindowManager` before a third secondary window lands

Module-scope `let activityWindow: BrowserWindow | undefined` works for one secondary window. Two more (Settings-as-window, Diagnostics-as-window) and we have five module-scope variables across five files, plus duplicated `closed`-listener cleanup.

## Problem Statement

`apps/desktop/src/main/messaging-activity-window.ts:15` is module-scope mutable state. Adding a second secondary window means a second module with the same pattern. By the third, the per-window code starts diverging in subtle ways (close behavior, focus behavior, channel scoping) and there's no central registry.

## Proposed Solution

Introduce a `WindowManager` on the main process that owns:

```ts
class WindowManager {
  private windows = new Map<WindowKind, BrowserWindow>();

  show(kind: WindowKind): { opened: boolean; alreadyOpen: boolean; windowId: number };
  close(kind: WindowKind): { closed: boolean };
  isOpen(kind: WindowKind): boolean;
  forEach(fn: (window: BrowserWindow, kind: WindowKind) => void): void;
}
```

The IPC handler in `messaging-status.ts:113` becomes `windowManager.show("messaging-activity")`. The IPC fan-out in todo #002 becomes `windowManager.forEach(...)` for opt-in subscriptions.

**Effort:** 4-6 hours
**Risk:** Low (refactor only, behavior unchanged)

## Recommended Action

(To be filled during triage.) Land BEFORE the second secondary window, or as part of the work that adds the second.

## Affected Files

- `apps/desktop/src/main/messaging-activity-window.ts`
- `apps/desktop/src/main/window.ts`
- `apps/desktop/src/main/ipc/messaging-status.ts`
- New: `apps/desktop/src/main/window-manager.ts`

## Resources

- **PR:** #198
- **Reviewer:** architecture-strategist — I1
- **Related todos:** #002 (IPC fan-out scoping benefits from this), #007 (structured open/close result)

## Acceptance Criteria

- [ ] One `WindowManager` owns all secondary windows
- [ ] `messaging-activity-window.ts` becomes a thin factory called by the manager
- [ ] No regression in current activity-window behavior
- [ ] Future windows are one entry, not one file

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via architecture-strategist
