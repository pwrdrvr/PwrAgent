---
title: Fix Edits Status Badges
type: fix
date: 2026-06-17
origin: docs/brainstorms/2026-06-17-edits-status-badge-scope-requirements.md
---

# Fix Edits Status Badges

## Summary

Limit Edits lifecycle status to one live file-state hint on the newest `By turn` group. Remove SHA chips from edit groups, hide lifecycle badges from historical and `All files` views, and add tooltips that describe the current-worktree semantics without implying turn-to-commit provenance.

## Problem Frame

The Edits UI currently attaches live Git path-state metadata to every historical turn group. That makes older turn diffs look tied to a current commit or push state even though later worktree changes, rebases, and path mismatches can make that metadata unrelated to the original turn.

## Requirements

**Badge visibility**

- R1. Show a lifecycle badge only on the first visible edit group in the `By turn` view.
- R2. Hide lifecycle badges on older `By turn` groups.
- R3. Hide lifecycle badges in the `All files` view.
- R4. Remove commit SHA and short-SHA display from edit groups.

**Badge meaning and copy**

- R5. Keep `UNCOMMITTED`, `COMMITTED`, and `PUSHED` labels as live file-state hints for the newest group only.
- R6. Add tooltip copy for each status that matches the origin requirements.
- R7. Preserve the `This turn` live badge behavior for active live groups.
- R8. Preserve group-level ignored-file hints and per-row ignored-file chips.

**Surface coverage**

- R9. Apply the same behavior in the sidebar Edits panel and above-composer transcript float-over.
- R10. Preserve group summaries, timestamps, diff stats, file rows, expansion behavior, and view toggles.

---

## Key Technical Decisions

- **Gate status at the group-list level:** `EditedFileGroupList` already knows view mode and group order, so it should decide whether a group may receive a lifecycle state instead of pushing that decision into the Git resolver.
- **Keep the resolver unchanged:** `resolveEditCommitStates` remains useful for the newest group and ignored-file metadata; changing its Git semantics would exceed the origin scope.
- **Simplify the badge component:** `EditGroupCommitBadge` should render only the status pill and ignored-file hint. The SHA copy affordance should be removed from this surface because it reads as commit attribution.
- **Use the existing viewport tooltip pattern:** The status pill should use `useViewportTooltip`, matching existing clipped-surface tooltip behavior in the Edits rail instead of relying on native `title` text.

---

## Implementation Units

### U1. Gate Badge Visibility by View and Group Position

- **Goal:** Ensure only the newest `By turn` group can receive lifecycle status while older groups and `All files` render without status badges.
- **Requirements:** R1, R2, R3, R7, R9, R10; covers AE1, AE2, AE5 from the origin.
- **Dependencies:** None.
- **Files:**
  - `apps/desktop/src/renderer/src/features/thread-detail/EditedFileGroupList.tsx`
  - `apps/desktop/src/renderer/src/features/thread-detail/__tests__/EditedFileGroupList.test.tsx`
  - `apps/desktop/src/renderer/src/features/thread-detail/context-panels/__tests__/EditsPanel.test.tsx`
- **Approach:** In the grouped rendering path, pass a commit state only to the first visible group when the effective view is `turns`. Leave live groups on their existing `This turn` tag path, and leave `EditedFileFlatSection` without badge props.
- **Patterns to follow:** Preserve the existing `visibleGroups.map((group, index) => ...)` structure and the current `showSingleGroupHeader` behavior used by the sidebar.
- **Test scenarios:**
  - Covers AE1. Render two historical groups with states for both; expect only the newest visible group to show a lifecycle label.
  - Covers AE2. Render multiple groups in `files` view; expect no lifecycle label and no SHA text.
  - Covers AE5. Render the sidebar panel with a single group; expect the single header, timestamp affordance, and top-group badge to remain visible.
  - Expand hidden groups through the "Show more" affordance; expect newly visible older groups not to receive lifecycle labels even when states exist.
- **Verification:** Renderer tests prove badge visibility is tied to top `By turn` position and that existing grouping, timestamps, and file rows still render.

### U2. Remove SHA Display and Add Status Tooltips

- **Goal:** Make the remaining lifecycle badge describe live state without exposing a SHA chip or copy action.
- **Requirements:** R4, R5, R6, R8; covers AE3 and AE4 from the origin.
- **Dependencies:** U1.
- **Files:**
  - `apps/desktop/src/renderer/src/features/thread-detail/EditGroupCommitBadge.tsx`
  - `apps/desktop/src/renderer/src/styles/app.css`
  - `apps/desktop/src/renderer/src/features/thread-detail/__tests__/EditedFileGroupList.test.tsx`
- **Approach:** Remove the copyable SHA element and its copy-text dependency from `EditGroupCommitBadge`. Attach a viewport tooltip to the status pill with status-specific copy from the origin document. Keep the ignored-file hint after the status pill.
- **Patterns to follow:** Reuse `useViewportTooltip({ className: "viewport-tooltip" })`, as used by nearby chrome and context-rail controls. Keep the existing status color classes.
- **Test scenarios:**
  - Covers AE3. Render an uncommitted top group, focus or hover the status pill, and expect the tooltip to explain that changes may be unrelated to the turn.
  - Covers AE4. Render a pushed top group, focus or hover the status pill, and expect the tooltip to describe only the most recent pushed commit touching some files in the set.
  - Render a committed-but-not-pushed top group and expect the committed tooltip copy from the origin.
  - Render a state with `commitSha` and `shortSha`; expect no SHA text and no "Copy commit" role.
  - Render ignored paths; expect the group-level ignored count and per-row ignored chip to remain.
- **Verification:** Renderer tests prove the status pill is explanatory, keyboard-visible, and no longer exposes commit copying.

### U3. Align Context Panel Expectations and Type Comments

- **Goal:** Keep tests and developer-facing comments aligned with the reduced status semantics.
- **Requirements:** R8, R9, R10.
- **Dependencies:** U1, U2.
- **Files:**
  - `apps/desktop/src/renderer/src/features/thread-detail/context-panels/__tests__/EditsPanel.test.tsx`
  - `apps/desktop/src/renderer/src/features/thread-detail/__tests__/EditedFileGroupList.test.tsx`
  - `apps/desktop/src/renderer/src/features/thread-detail/EditGroupCommitBadge.tsx`
  - `packages/shared/src/contracts/navigation.ts`
- **Approach:** Update tests that currently expect SHA text in the sidebar and update comments that describe the badge as a commit lifecycle plus SHA chip. Keep the shared contract honest that the state is live worktree metadata rather than provenance.
- **Patterns to follow:** Preserve repo-relative references and avoid changing shared type shape unless implementation reveals a real type mismatch.
- **Test scenarios:**
  - Sidebar single-group tests should expect the status badge but no SHA.
  - View-toggle regression tests should cover that moving from `All files` back to a single visible group does not reintroduce historical badges.
  - Existing ignored-file tests should continue to pass after comments and component simplification.
- **Verification:** Focused renderer tests pass and comments no longer describe removed SHA behavior.

---

## Scope Boundaries

- Exact turn-to-commit provenance stays out of scope.
- Exact commit diff fetching or rendering stays out of scope.
- Main-process Git resolution stays out of scope unless implementation reveals that renderer gating cannot preserve ignored-file behavior.
- Live diff parsing, row rendering, and file diff expansion stay out of scope.

---

## Risks & Dependencies

- **Tooltip test fragility:** Portal-rendered viewport tooltips require hover/focus events and document-body queries; tests should assert visible tooltip text without over-specifying pixel placement.
- **Ignored-file metadata coupling:** Hiding old group badges must not hide ignored-file row chips, because row chips rely on the union of `ignoredPaths` across resolved states.
- **Single-group sidebar behavior:** The sidebar intentionally preserves a group header for one group; this remains the only historical case where a badge may appear because that one group is also the newest group.

---

## Acceptance Examples

- AE1. Given the `By turn` view shows multiple historical edit groups, only the top group may show `UNCOMMITTED`, `COMMITTED`, or `PUSHED`.
- AE2. Given the user switches to `All files`, the merged view shows no lifecycle badge and no SHA.
- AE3. Given the top group is uncommitted, the status tooltip says files in the set have uncommitted changes and that changes may be unrelated to this turn's edits.
- AE4. Given the top group is pushed, the status tooltip says the most recent commit touching some files in the set was pushed.
- AE5. Given the same groups render in the sidebar and above-composer rail, older groups retain summaries, timestamps, diff stats, and rows without lifecycle badges.

---

## Sources & Research

- `docs/brainstorms/2026-06-17-edits-status-badge-scope-requirements.md` is the origin document for user-facing behavior and scope boundaries.
- `apps/desktop/src/renderer/src/features/thread-detail/EditedFileGroupList.tsx` owns view mode, group order, and the current per-group badge attachment point.
- `apps/desktop/src/renderer/src/features/thread-detail/EditGroupCommitBadge.tsx` owns current lifecycle label and SHA rendering.
- `apps/desktop/src/renderer/src/features/thread-detail/context-panels/EditsPanel.tsx` and `apps/desktop/src/renderer/src/features/thread-detail/LiveWorkRail.tsx` share `EditedFileGroupList`, so the shared component is the right surface for parity.
- `apps/desktop/src/renderer/src/features/thread-detail/__tests__/EditedFileGroupList.test.tsx` and `apps/desktop/src/renderer/src/features/thread-detail/context-panels/__tests__/EditsPanel.test.tsx` already cover the affected renderer behavior.
- `apps/desktop/src/main/app-server/git-working-state-service.ts` confirms that commit state is live Git path state; this plan does not change that resolver.
