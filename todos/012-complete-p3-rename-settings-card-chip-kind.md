---
status: pending
priority: p3
issue_id: "012"
tags: [code-review, naming, settings]
dependencies: ["008"]
---

# Rename `SettingsCardChipKind` → match `SettingsSection` component name

Type is named `SettingsCardChipKind` but is used to type `chipKind` on the `SettingsSection` component. The `Card` in the type vs `Section` in the component is an unforced inconsistency.

## Problem Statement

`apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx:17` exports `SettingsCardChipKind`. The CSS class is `.settings-card__chip` (which mirrors the v2 design's `pa-card__chip`). The component is `SettingsSection`.

A future maintainer encountering "card" vs "section" in three places (CSS class, type name, component name) for the same concept will pause every time.

## Proposed Solutions

### Option 1: Pick one — `SettingsSectionChipKind`

Rename the type (and the CSS class if you want full alignment). Update callsites.

### Option 2: Adopt the chip-tone unification from todo #008

If todo #008 lands first (one shared `SettingsChipTone` enum), this becomes moot.

## Recommended Action

(To be filled during triage.) Option 2 — bundle with todo #008.

## Affected Files

- `apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx:17`
- (Optionally) `apps/desktop/src/renderer/src/styles/app.css` — `.settings-card__chip*` classes

## Resources

- **PR:** #198
- **Reviewer:** architecture-strategist — I6

## Acceptance Criteria

- [ ] Type name aligned with the component name (or eliminated via todo #008)

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via architecture-strategist
