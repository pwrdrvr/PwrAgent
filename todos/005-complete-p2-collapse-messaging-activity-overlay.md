---
status: pending
priority: p2
issue_id: "005"
tags: [code-review, simplicity, messaging-activity]
dependencies: []
---

# Collapse `MessagingActivityOverlay` into `MessagingActivityWindow`

Three components for one surface (`MessagingActivityWindow → MessagingActivityOverlay → MessagingActivityScreen`). The Overlay layer was originally intended to be embeddable inside Settings as a section; that use case was abandoned when Activity moved to its own window. Today Overlay is only ever called from Window.

## Problem Statement

`apps/desktop/src/renderer/src/features/messaging-activity/MessagingActivityOverlay.tsx:19-45` exists solely to render the title-bar + content wrapper around `<MessagingActivityScreen />`. It has one caller (`MessagingActivityWindow.tsx`). The Window itself is also a thin wrapper.

The reuse story this layer was designed for (settings-section embedding) doesn't exist. Half the doc-comments explain what each layer is *for* — a smell.

## Findings

- `MessagingActivityOverlay.tsx:19-45` — render-only wrapper around `MessagingActivityScreen` with the activity titlebar.
- `MessagingActivityWindow.tsx:30-34` — wraps Overlay in a `<div className="messaging-activity-window">` and sets `document.title`.
- `MessagingActivityScreen.tsx` — the data-fetching screen with the pinned/flex/capped layout.
- No other callers of `MessagingActivityOverlay`.

## Proposed Solutions

### Option 1: Inline Overlay into Window

**Approach:** Move Overlay's titlebar + content wrapper markup into `MessagingActivityWindow`. Delete `MessagingActivityOverlay.tsx`.

Result:
- `MessagingActivityWindow` becomes the chrome layer (root container + titlebar + document.title effect).
- `MessagingActivityScreen` stays the data layer.
- Two files instead of three.

**Pros:**
- Removes a redundant indirection.
- Aligns layer count with actual responsibilities.

**Cons:**
- Slightly larger Window file (~30 more lines of JSX).
- Future re-extraction (e.g. if Activity gets re-embedded in Settings) requires undoing this.

**Effort:** 20 min
**Risk:** Low

### Option 2: Defer

Leave the indirection — no harm beyond the doc-comment overhead.

**Effort:** 0
**Risk:** Low

## Recommended Action

(To be filled during triage.) Option 1 — the reuse story is gone; the indirection is overhead.

## Technical Details

**Affected files:**
- `apps/desktop/src/renderer/src/features/messaging-activity/MessagingActivityOverlay.tsx` — delete
- `apps/desktop/src/renderer/src/features/messaging-activity/MessagingActivityWindow.tsx` — absorb the titlebar markup

## Resources

- **PR:** #198
- **Reviewer:** code-simplicity-reviewer — #3 (P1 in their stack)
- **Related:** `architecture-strategist` N2 also flagged the three-component overlap

## Acceptance Criteria

- [ ] `MessagingActivityOverlay.tsx` deleted
- [ ] Visual / functional behavior unchanged
- [ ] Tests still pass
- [ ] Doc-comments simplified (no longer need to explain the overlay layer)

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via code-simplicity-reviewer
