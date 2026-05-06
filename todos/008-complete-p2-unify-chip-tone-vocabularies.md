---
status: pending
priority: p2
issue_id: "008"
tags: [code-review, architecture, design-system, settings]
dependencies: []
---

# Unify chip-tone vocabularies between `SettingsCardChipKind` and `SettingsPathRowChip.tone`

Three distinct overlapping vocabularies for "chip color" exist in the new settings primitives. Without a single tone enum, design drift between section chips and pathrow chips is inevitable.

## Problem Statement

- `SettingsCardChipKind` (`apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx:17`): `"default" | "ok" | "err" | "warn"`
- `SettingsPathRowChip.tone` (`apps/desktop/src/renderer/src/features/settings/SettingsPathRow.tsx:5`): `"ok" | "err" | "muted"`
- CSS modifiers in `app.css`: `.settings-pathrow__chip--ok`, `.settings-pathrow__chip--err`

Notable mismatches:
- `muted` ≠ `default` (visually different even if semantically similar).
- `warn` is missing from `SettingsPathRow`.

A future "warn" pathrow chip (e.g. for an env-overridden but otherwise-valid path) has no obvious tone today. A designer reading the type definitions sees two enums with different values for the same conceptual axis.

## Findings

- Both primitives shipped together in this PR.
- No external consumers of either tone enum yet.
- Theme-contract test doesn't enforce parity.

## Proposed Solutions

### Option 1: One shared `SettingsChipTone` enum

**Approach:**

```ts
// SettingsLayout.tsx (or a new `settings-tones.ts`)
export type SettingsChipTone = "default" | "muted" | "ok" | "err" | "warn";
```

Export from one place, import in both `SettingsLayout` (for `SettingsSection.chipKind`) and `SettingsPathRow` (for `SettingsPathRowChip.tone`). Add CSS modifiers for any missing variants on each primitive.

**Pros:**
- One source of truth.
- New tones (`info`?) added in one place, propagate to all chips.
- Theme-contract test can lock parity.

**Cons:**
- Slight rename (callers using `SettingsCardChipKind` need to import from new location, or re-export it as an alias).

**Effort:** 1 hour
**Risk:** Low

### Option 2: Rename both to converge

**Approach:** Rename `SettingsCardChipKind` to use the same tone names as `SettingsPathRowChip`, OR vice versa. No new shared enum, just consistent vocabulary.

**Pros:**
- Smaller change.

**Cons:**
- Doesn't enforce parity going forward.

**Effort:** 30 min
**Risk:** Low

## Recommended Action

(To be filled during triage.) Option 1 — establishes the design-token discipline before drift accumulates.

## Technical Details

**Affected files:**
- `apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx:17` — `SettingsCardChipKind`
- `apps/desktop/src/renderer/src/features/settings/SettingsPathRow.tsx:5` — `SettingsPathRowChip.tone`
- `apps/desktop/src/renderer/src/styles/app.css` — add missing CSS modifiers
- `apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.tsx` — optional: lock parity

## Resources

- **PR:** #198
- **Reviewer:** architecture-strategist — I7

## Acceptance Criteria

- [ ] Both primitives import the same `SettingsChipTone` type
- [ ] All five tones (default/muted/ok/err/warn) have CSS modifiers on each primitive
- [ ] Existing callers still work (no semantic regression)
- [ ] (Optional) Theme-contract test asserts parity

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via architecture-strategist agent
