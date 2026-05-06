---
status: pending
priority: p3
issue_id: "013"
tags: [code-review, typescript, settings]
dependencies: []
---

# Narrow `SettingsField.label` from `ReactNode` to `string`

`SettingsField` types `label` as `ReactNode`. Every caller today passes a string. The legacy `SettingsRow` (proposed for deletion in todo #004) types it as `string`. The mixed convention is the actual smell.

## Problem Statement

`apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx:88-124` types `SettingsField.label` as `ReactNode`. This allows `null`, arrays, `<>` fragments, etc. — none of which produce a sensible visual label adjacent to a control.

The `label` is also indirectly an accessibility input (it's the visible text adjacent to the control). Narrowing to `string` makes that contract explicit.

## Proposed Solution

Change `label: ReactNode` → `label: string`. Other slot props (`sub`, `help`, `source`, `control`, `error`) stay `ReactNode`.

**Effort:** 15 min (only one type change; callers all comply)
**Risk:** Low

## Recommended Action

(To be filled during triage.) Land as part of any pass through `SettingsLayout.tsx`.

## Affected Files

- `apps/desktop/src/renderer/src/features/settings/SettingsLayout.tsx:88`

## Resources

- **PR:** #198
- **Reviewer:** kieran-typescript — finding #5

## Acceptance Criteria

- [ ] `SettingsField.label: string`
- [ ] Other slot props remain `ReactNode`
- [ ] Typecheck passes

## Work Log

### 2026-05-06 - Initial Discovery (PR #198 review)

**By:** Claude Code via kieran-typescript-reviewer
