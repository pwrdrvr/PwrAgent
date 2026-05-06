---
status: pending
priority: p3
issue_id: "010"
tags: [code-review, simplicity, cleanup]
dependencies: []
---

# Small CSS + TypeScript cleanups (batch)

A handful of low-effort cleanups flagged across reviewers. Bundle into one cleanup commit — or skip entirely if the bigger todos cover the same files.

## Findings

### 1. Drop unused `--err` chip variant

- `SettingsLayout.tsx:17` defines `SettingsCardChipKind` with `"err"` but nothing passes it.
- CSS rule `.settings-card__chip--err` (`app.css:~2245`) never matches.
- Pure YAGNI; restore when the first caller appears.

### 2. Trim `MessagingActivityWindow` document.title cleanup

- `MessagingActivityWindow.tsx:22-28` captures `previous = document.title` and restores on unmount. Window is single-mount in practice; cleanup runs only when the renderer is destroyed.
- Replace with `useEffect(() => { document.title = "Messaging Activity"; }, []);` — net-correct for both StrictMode dev double-mount and prod single-mount.

### 3. Drop conditional in `closed` listener guard

- `messaging-activity-window.ts:67-69` does `if (activityWindow === window) { activityWindow = undefined; }`. The `=== window` guard protects against a race that the top-of-function check (`if (activityWindow && !destroyed)`) already prevents.
- Replace with unconditional `activityWindow = undefined`.

### 4. `.settings-empty` defined twice in CSS

- `app.css:2382-2388` shares a selector list with `.settings-row__error` and inherits `--danger-text`.
- `app.css:2398-2400` overrides the color back to `--text-secondary`.
- Reads as a copy-paste mistake. Remove `.settings-empty` from the first selector list.

### 5. `SettingsPathRow` chip uses `key={index}`

- `SettingsPathRow.tsx:65` keys chips by array index. Since chip arrays are built fresh each render today, the index is stable per-row, but adding a `key?: string` to `SettingsPathRowChip` (or deriving from `chip.tone + index`) would future-proof.

### 6. Theme-contract `extractRuleBody` regex picks first match

- `theme-contract.test.tsx:22-30` regex matches the first `{ ... \n}` after the selector. If `app.css` ever has nested `@media` rules with the same selector, the test silently picks the outermost block.
- Add a comment warning future maintainers; OR upgrade the regex to be media-query-aware. Not urgent.

## Proposed Solution

One cleanup commit applying #1-#4. #5 and #6 are even more optional.

**Effort:** 30-60 min
**Risk:** Low

## Recommended Action

(To be filled during triage.) Skip if bigger todos (#004, #005, #006) cover the same files; consolidate into one cleanup pass otherwise.

## Affected Files

- `apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx`
- `apps/desktop/src/renderer/src/features/messaging-activity/MessagingActivityWindow.tsx`
- `apps/desktop/src/main/messaging-activity-window.ts`
- `apps/desktop/src/renderer/src/styles/app.css`
- `apps/desktop/src/renderer/src/features/settings/SettingsPathRow.tsx`
- `apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.tsx`

## Resources

- **PR:** #198
- **Reviewers:** code-simplicity-reviewer #2/#5/#6/#7, kieran-typescript #6/#11

## Acceptance Criteria

- [ ] At least #1-#4 applied
- [ ] Tests still pass

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via two reviewers
