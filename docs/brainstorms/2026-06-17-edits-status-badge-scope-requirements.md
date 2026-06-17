---
date: 2026-06-17
topic: edits-status-badge-scope
---

# Edits Status Badge Scope Requirements

## Summary

The Edits surfaces should stop implying historical turn edits have reliable commit or push attribution. Keep one live file-state badge only on the newest `By turn` edit group, remove SHA display from edit groups, and make the remaining badge explain that it is a current worktree hint rather than proof of turn provenance.

---

## Problem Frame

The current Edits UI resolves `UNCOMMITTED`, `COMMITTED`, `PUSHED`, and a SHA from live Git path state, then attaches that result to turn edit groups. That can look like a turn-to-commit relationship, but the underlying state answers a narrower question: whether the files are currently dirty, which recent commit touched some of those paths, and whether that chosen commit is pushed.

Historical edit groups drift as the worktree changes. A later edit, commit, push, rebase, detached-head reset, or worktree-path mismatch can make an older turn display a status that is unrelated to what happened during that turn. This creates noise in the Edits sidebar and transcript float-over, and it can falsely suggest that a commit SHA contains hunks that were only transient turn activity.

---

## Key Decisions

- **Status is a current hint, not provenance.** The remaining badge should describe current file/worktree state and avoid claiming that the turn's edits were committed or pushed.
- **Only the newest turn gets a badge.** Older turn groups should not show commit lifecycle badges because their live path state becomes less trustworthy over time.
- **No SHA chip in edit groups.** A SHA next to a turn edit group reads as commit attribution, so it should be removed from this surface.

---

## Requirements

**Badge visibility**

- R1. Show `UNCOMMITTED`, `COMMITTED`, or `PUSHED` only for the first visible edit group in the `By turn` view.
- R2. Do not show commit lifecycle badges on older `By turn` groups.
- R3. Do not show commit lifecycle badges in the `All files` view.
- R4. Do not show a commit SHA or short-SHA chip on any edit group.

**Badge meaning**

- R5. `UNCOMMITTED` means files in the newest edit set currently have uncommitted changes.
- R6. `COMMITTED` means files in the newest edit set currently have no uncommitted changes.
- R7. `PUSHED` means the most recent commit touching some files in the newest edit set was pushed.
- R8. The UI must not imply that any status badge proves the turn's exact edits were committed or pushed.

**Tooltip copy**

- R9. The `UNCOMMITTED` tooltip should say: "Files in this set have uncommitted changes. Changes may be unrelated to this turn's edits."
- R10. The `COMMITTED` tooltip should say: "Files in this set currently have no uncommitted changes. Verify that changes from this turn were committed."
- R11. The `PUSHED` tooltip should say: "Most recent commit touching some files in this set was pushed."

**Surface coverage**

- R12. Apply the same badge visibility rules in the Edits sidebar and the transcript float-over.
- R13. Preserve existing edit group summaries, timestamps, file rows, and diff stats when badges are hidden.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R4.** Given the `By turn` Edits view shows four historical edit groups, when no turn is currently streaming, then only the top group may show a lifecycle badge and none of the groups show a SHA.
- AE2. **Covers R3, R4.** Given the user switches to `All files`, when the merged file list renders, then no lifecycle badge or SHA appears for that merged view.
- AE3. **Covers R5, R9.** Given the newest edit group's files currently have uncommitted changes, when the badge renders, then it says `UNCOMMITTED` and the tooltip explains that changes may be unrelated to this turn's edits.
- AE4. **Covers R7, R11.** Given the newest edit group's displayed status resolves to `PUSHED`, when the user inspects the badge, then the UI describes only the pushed state of the most recent commit touching some files in the set.
- AE5. **Covers R12, R13.** Given the transcript float-over and the Edits sidebar show the same edit groups, when older groups render in either surface, then their file summaries, timestamps, and diff stats remain visible without lifecycle badges.

---

## Scope Boundaries

- Exact turn-to-commit provenance is out of scope for this slice.
- Fetching and rendering exact commit diffs is out of scope for this slice.
- Replacing live Git path-state resolution is out of scope unless needed to keep the newest badge from showing stale or mismatched worktree data.
- Existing live-diff and file-row rendering behavior should not be redesigned as part of this cleanup.

---

## Dependencies / Assumptions

- The remaining top-group badge depends on live Git path-state resolution, not timestamps from the transcript.
- The resolver must receive paths and a worktree root that refer to the same checkout; stale absolute paths or mismatched worktree identity can make even the newest badge misleading.
- `PUSHED` remains a statement about the selected commit's remote reachability, not proof that every file or hunk in the edit set was pushed.

---

## Sources / Research

- `apps/desktop/src/renderer/src/features/thread-detail/EditGroupCommitBadge.tsx` currently renders lifecycle labels and a copyable SHA chip.
- `apps/desktop/src/renderer/src/features/thread-detail/EditedFileGroupList.tsx` attaches the badge to each grouped edit section.
- `apps/desktop/src/renderer/src/features/thread-detail/useEditCommitStates.ts` resolves edit group state only when an Edits surface is visible.
- `apps/desktop/src/main/app-server/git-working-state-service.ts` resolves commit state from live Git path status and recent path history.
- `packages/shared/src/contracts/navigation.ts` defines `EditGroupCommitState` as live worktree metadata rather than transcript provenance.
