---
status: pending
priority: p2
issue_id: "004"
tags: [code-review, simplicity, dead-code, settings]
dependencies: []
---

# Delete the unused `SettingsRow` legacy primitive

`SettingsRow` was kept as "legacy for non-settings callsites" (transcript/questionnaire/mcp surfaces), but a grep across the repo confirms NO non-settings TSX uses the `.settings-row` className or imports the component. It's dead.

## Problem Statement

`apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx:131-156` exports `SettingsRow`, intended as a legacy primitive for transcript/questionnaire/mcp consumers. The original plan called for keeping it specifically because of those callsites (see `docs/plans/2026-05-06-001-feat-settings-screens-design-alignment-plan.md` "Key Decisions" — "Split `.settings-field` from `.settings-row`").

But: a search for `settings-row` className or `SettingsRow` import outside `features/settings/` finds zero hits. The plan's premise was wrong.

## Findings

- `SettingsLayout.tsx:131-156` — `SettingsRow` function (~26 lines).
- `app.css` — rules `.settings-row`, `.settings-row--inline`, `.settings-row__label`, `.settings-row__label-text`, `.settings-row__help`, `.settings-row__control` (search around lines 2284-2330).
- Confirmed via `grep -rn "settings-row\|SettingsRow" apps/desktop/src/renderer/ --include="*.tsx" --include="*.ts"` — only hits are inside `features/settings/`.
- `.settings-row__error` and `.settings-row__description` ARE still used by `SettingsField` (which renders an error and a description through these classes). Keep those rules; they could be renamed to `.settings-error` / `.settings-description` in a follow-up.

## Proposed Solutions

### Option 1: Delete now

**Approach:**
- Drop the `SettingsRow` function from `SettingsLayout.tsx`.
- Drop the unused CSS rules (`.settings-row`, `.settings-row--inline`, `.settings-row__label`, `.settings-row__label-text`, `.settings-row__help`, `.settings-row__control`).
- Keep `.settings-row__error` and `.settings-row__description` (still used inside SettingsField).

**Pros:**
- Removes ~30 lines TS + ~60 lines CSS.
- Eliminates a "two ways to do it" footgun in the canonical layout file.

**Cons:**
- Future re-introduction would re-do the work.

**Effort:** 30 min
**Risk:** Low (typecheck + tests will catch any missed import)

### Option 2: Defer

Leave as-is until someone needs the pattern again.

**Effort:** 0
**Risk:** Low

## Recommended Action

(To be filled during triage.) Option 1 — confirmed dead code; one of the strongest signals across the review.

## Technical Details

**Affected files:**
- `apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx:131-156`
- `apps/desktop/src/renderer/src/styles/app.css:~2284-2330`

## Resources

- **PR:** #198
- **Reviewer:** code-simplicity-reviewer — #1 (P1 in their stack)
- **Conflicting prior decision:** plan's "Key Decisions" — needs to be marked superseded

## Acceptance Criteria

- [ ] `SettingsRow` export removed
- [ ] Unused `.settings-row*` rules removed (keeping `__error`/`__description`)
- [ ] Full test suite passes
- [ ] No imports of `SettingsRow` remain anywhere

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via code-simplicity-reviewer
