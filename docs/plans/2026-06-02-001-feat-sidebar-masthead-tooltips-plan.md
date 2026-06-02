---
title: feat: Add sidebar masthead action tooltips
type: feat
status: completed
date: 2026-06-02
---

# feat: Add sidebar masthead action tooltips

## Overview

Add hover and focus tooltips for the three icon-only actions in the left sidebar masthead so operators do not have to infer meaning from the icons alone. The change should reuse the desktop app's existing viewport-safe tooltip pattern and keep the visible chrome unchanged.

## Problem Frame

The sidebar masthead currently exposes three icon-only buttons for automations, settings, and new thread creation. They already have `aria-label` text for assistive technology, but pointer users and sighted keyboard users do not get an on-screen caption that confirms what each icon does. This creates unnecessary guesswork in a high-frequency navigation surface.

## Requirements Trace

- R1. The Automations masthead button shows a readable caption on hover and keyboard focus.
- R2. The Settings masthead button shows a readable caption on hover and keyboard focus.
- R3. The New thread masthead button shows a readable caption on hover and keyboard focus.
- R4. The tooltip implementation must follow existing desktop tooltip patterns for clipped sidebar surfaces and must not change click behavior, disabled behavior, or active-state styling of the buttons.

## Scope Boundaries

- No redesign of the sidebar masthead layout, iconography, or button ordering.
- No rename of the existing actions beyond whatever text is chosen for tooltip copy consistency.
- No broader tooltip rollout for other sidebar controls outside these three masthead buttons.

## Context & Research

### Relevant Code and Patterns

- `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx` renders the three masthead icon buttons and already contains tooltip-aware helper buttons for profile and runtime identity rows.
- `apps/desktop/src/renderer/src/lib/useViewportTooltip.tsx` is the shared portal tooltip hook for surfaces that can clip pseudo-element tooltips.
- `apps/desktop/src/renderer/src/styles/app.css` defines the shared `.viewport-tooltip` styling consumed by the hook.
- `apps/desktop/src/renderer/src/features/navigation/__tests__/sidebar.test.tsx` already verifies sidebar tooltip behavior for profile identity and runtime identity buttons, so it is the right home for regression coverage.

### Institutional Learnings

- No directly relevant `docs/solutions/` entry was found for this sidebar tooltip affordance.

### External References

- None. Local patterns are already strong and specific for this UI surface.

## Key Technical Decisions

- Reuse `useViewportTooltip` and `.viewport-tooltip` instead of native `title` attributes or CSS pseudo-element tooltips because `apps/desktop/AGENTS.md` explicitly calls for viewport tooltips inside clipped sidebar surfaces.
- Keep tooltip copy aligned with the semantic action names already exposed via `aria-label` so visible and assistive labels do not drift.
- Implement the masthead buttons through a small local helper component or shared event wiring inside `Sidebar.tsx` rather than introducing a new global button primitive for a three-button-only need.

## Open Questions

### Resolved During Planning

- Which tooltip mechanism should be used: the existing viewport tooltip hook, not `title` and not `tooltip-target`.
- Should the tooltip text differ from the button accessibility labels: no, keep them aligned unless implementation reveals a strong product-copy reason to diverge.

### Deferred to Implementation

- Whether the masthead buttons should share one local tooltip controller or each render through a tiny reusable helper component. Either is acceptable if it keeps event handling straightforward and testable.

## Implementation Units

- U1. **Wire masthead icon buttons to viewport tooltips**

**Goal:** Add visible hover/focus captions to the Automations, Settings, and New thread buttons in the sidebar masthead without changing their existing actions or visual states.

**Requirements:** R1, R2, R3, R4

**Dependencies:** None

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx`
- Test: `apps/desktop/src/renderer/src/features/navigation/__tests__/sidebar.test.tsx`

**Approach:**
- Extend the masthead action rendering so each icon button shows a viewport tooltip on `mouseenter` and `focus`, and hides it on `mouseleave`, `blur`, and click as appropriate.
- Use the same text as the existing labels: `Open automations`, `Open settings`, and `New thread`, unless implementation chooses to trim the leading verb consistently across all three.
- Keep the current `aria-label`, `aria-pressed`, `disabled`, and `onClick` semantics intact.
- Prefer colocated helper logic in `Sidebar.tsx` because that file already contains sidebar-specific tooltip button patterns.

**Patterns to follow:**
- `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx` `ProfileIdentityButton`
- `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx` `RuntimeIdentityButton`
- `apps/desktop/src/renderer/src/lib/useViewportTooltip.tsx`

**Test scenarios:**
- Happy path: hovering the Automations button renders a tooltip with the expected caption.
- Happy path: hovering the Settings button renders a tooltip with the expected caption.
- Happy path: hovering the New thread button renders a tooltip with the expected caption when the button is enabled.
- Edge case: focusing each button by keyboard renders the same tooltip copy as hover.
- Edge case: leaving or blurring the button removes the tooltip from the DOM.
- Error path: when `creatingThread` disables the New thread button, the button remains disabled and does not regress its disabled semantics while tooltip wiring is present.
- Integration: clicking each button still invokes the existing handler path and does not leave a stale tooltip visible after activation.

**Verification:**
- Sidebar masthead buttons remain visually unchanged except for visible hover/focus captions.
- Tooltips escape the sidebar without clipping and disappear when the interaction ends.
- Existing button interactions still work exactly as before.

---

- U2. **Add focused sidebar regression coverage**

**Goal:** Lock the new masthead tooltip behavior into the sidebar test suite so future icon-only changes do not silently remove the captions.

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/navigation/__tests__/sidebar.test.tsx`

**Approach:**
- Add one or two targeted tests near the existing tooltip coverage instead of scattering assertions throughout unrelated sidebar tests.
- Reuse the existing render shape and `fireEvent.mouseEnter` / `fireEvent.mouseLeave` / focus assertions already used for other sidebar tooltip tests.
- Cover both visibility and interaction safety so the tests protect against regressions where a tooltip appears but button behavior changes.

**Patterns to follow:**
- `apps/desktop/src/renderer/src/features/navigation/__tests__/sidebar.test.tsx` profile tooltip test
- `apps/desktop/src/renderer/src/features/navigation/__tests__/sidebar.test.tsx` runtime identity tooltip tests

**Test scenarios:**
- Happy path: each masthead button shows the expected tooltip text on hover.
- Edge case: tooltip visibility can move from one masthead button to another without leaving duplicate tooltips behind.
- Integration: clicking the Automations and Settings buttons still calls their handlers after tooltip hover.
- Integration: clicking New thread still calls `onCreateThread` when enabled.

**Verification:**
- The sidebar test suite fails if tooltip copy disappears, if hover/focus stops producing a tooltip, or if button handler behavior regresses.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Tooltip implementation gets clipped or layered behind the sidebar surface | Reuse `useViewportTooltip` with `.viewport-tooltip`, per `apps/desktop/AGENTS.md` guidance |
| Tooltip wiring changes click or disabled behavior on the icon buttons | Keep existing button props intact and add sidebar interaction assertions in tests |
| Tooltip copy drifts from accessibility labels | Derive tooltip strings from the same semantic action labels or keep them adjacent in one helper |

## Documentation / Operational Notes

- No docs update is required. This is a self-evident UI affordance improvement in the desktop shell.

## Sources & References

- Related code: `apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx`
- Related code: `apps/desktop/src/renderer/src/lib/useViewportTooltip.tsx`
- Related tests: `apps/desktop/src/renderer/src/features/navigation/__tests__/sidebar.test.tsx`
- Guidance: `apps/desktop/AGENTS.md`
