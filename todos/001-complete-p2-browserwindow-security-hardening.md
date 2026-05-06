---
status: pending
priority: p2
issue_id: "001"
tags: [code-review, security, electron, defense-in-depth]
dependencies: []
---

# Apply BrowserWindow security guards to the Activity window

The new Messaging Activity BrowserWindow inherits the right `webPreferences` (sandbox, contextIsolation, nodeIntegration: false, preload) but skips the per-window `setWindowOpenHandler` and `will-navigate` guards the main window applies. A future renderer-side bug or XSS in the activity surface could spawn an unguarded child window or navigate the existing window away.

## Problem Statement

`apps/desktop/src/main/messaging-activity-window.ts:37-53` creates the activity BrowserWindow with the correct hardened preload settings, but does not call `webContents.setWindowOpenHandler(...)` (which `createMainWindow` does at `apps/desktop/src/main/window.ts:237-245`) or attach a `will-navigate` listener.

This is **not P1** today — the activity surface only loads first-party assets, the renderer never calls `window.open(...)`, and the activity-log content is sanitized. But the defense-in-depth posture of the main window is silently absent on the second window. Any future addition that triggers a navigation/popup from the activity surface defaults to *Electron's default settings*, not the hardened ones.

## Findings

- `apps/desktop/src/main/window.ts:237-245` — main window `setWindowOpenHandler` denies all renderer-driven new-window creation, optionally calling `shell.openExternal` only for safelisted URLs (https/mailto/file/loopback http).
- `apps/desktop/src/main/messaging-activity-window.ts:37-53` — activity window has neither `setWindowOpenHandler` nor `will-navigate`. Closes correctly via the `closed` listener at line 64.
- Codebase has no global `app.on("web-contents-created", ...)` hook, so each new BrowserWindow needs its own per-window guards.

## Proposed Solutions

### Option 1: Shared `applyWindowSecurityHardening(window)` helper

**Approach:** Extract `setWindowOpenHandler` + `will-navigate` deny-list into a helper exported from `window.ts`. Both `createMainWindow` and `showMessagingActivityWindow` call it.

**Pros:**
- Symmetric — both windows share one source of truth for security posture.
- Future window additions get the guards by default if they call the helper.

**Cons:**
- Three-line change to `window.ts` and `messaging-activity-window.ts`.

**Effort:** 30 min
**Risk:** Low

### Option 2: Global `app.on("web-contents-created", ...)` bootstrap

**Approach:** Move the guards to a top-level `app.on("web-contents-created")` listener in `apps/desktop/src/main/index.ts` so EVERY future BrowserWindow inherits the posture without per-window plumbing.

**Pros:**
- Authors can't forget — even a quick prototype window is hardened.
- Smallest steady-state code.

**Cons:**
- Slightly more disruptive to land — touches the bootstrap flow.

**Effort:** 1 hour
**Risk:** Low (bounded blast radius — adds a listener)

## Recommended Action

(To be filled during triage.) Option 2 if we expect more BrowserWindows soon (Settings-as-window, Diagnostics, etc.); Option 1 otherwise.

## Technical Details

**Affected files:**
- `apps/desktop/src/main/messaging-activity-window.ts` — add `setWindowOpenHandler` + `will-navigate`
- `apps/desktop/src/main/window.ts` — extract helper, or move guards out into bootstrap
- (Option 2) `apps/desktop/src/main/index.ts` — global hook

## Resources

- **PR:** #198
- **Reviewer:** security-sentinel — F1 (medium / not P1)
- **Existing pattern:** `createMainWindow` in `window.ts:237-245`

## Acceptance Criteria

- [ ] Activity window has the same `setWindowOpenHandler` posture as the main window
- [ ] `will-navigate` listener prevents the activity surface from being navigated to attacker-controlled URLs
- [ ] (Optional) Global `web-contents-created` hook ensures future windows inherit the posture
- [ ] Tests cover the deny posture (or at least a manual smoke test verifies external link clicks route through `shell.openExternal`)

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via security-sentinel agent

**Actions:**
- Identified missing window security guards on the new activity BrowserWindow
- Compared against `createMainWindow` (which DOES have them)
- Drafted two remediation options
