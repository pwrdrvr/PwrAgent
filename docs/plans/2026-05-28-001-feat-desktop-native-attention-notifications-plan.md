---
title: "feat(desktop): native attention notifications"
type: feat
status: active
date: 2026-05-28
origin: docs/brainstorms/2026-05-28-desktop-native-attention-notifications-requirements.md
---

# Native Attention Notifications

## Overview

Add opt-in native desktop notifications that alert users when a turn needs attention (approval/user-input prompts) and when turns terminate (completed/failed/cancelled), but only while the app is unfocused or minimized.

---

## Problem Frame

Operators multitask while turns run and should not need to poll the app to know when they must intervene or when work is done (see origin: `docs/brainstorms/2026-05-28-desktop-native-attention-notifications-requirements.md`).

---

## Requirements Trace

- R1. Add one General Settings toggle for desktop-native notifications.
- R2. Keep notifications default-off (explicit opt-in).
- R3. Handle OS permission flow and surface permission state.
- R4. Preserve enabled toggle when permission is denied and show visible denied state.
- R5. Notify on attention-required events, including approval requests and user-input questions.
- R6. Emit one attention notification per unresolved waiting turn.
- R7. Notify on all terminal outcomes: completed, failed, cancelled.
- R8. Notify only when app is minimized or unfocused.

**Origin actors:** A1 (desktop operator), A2 (desktop app), A3 (OS notification service)
**Origin flows:** F1 (opt in), F2 (attention-required while inactive), F3 (terminal while inactive)
**Origin acceptance examples:** AE1 (permission denied state), AE2 (approval one-shot), AE3 (terminal failure notification)

---

## Scope Boundaries

- No reminder cadence beyond one-shot per unresolved waiting turn.
- No per-event sub-toggles in v1 (single global notifications control).
- No focused-window native toast behavior.

### Deferred to Follow-Up Work

- Optional click-through behavior from notification to specific thread.
- Optional custom notification copy templates/localization pass.

---

## Context & Research

### Relevant Code and Patterns

- Settings shape and TOML patching: `packages/shared/src/contracts/settings.ts`, `apps/desktop/src/main/settings/desktop-config.ts`, `apps/desktop/src/main/settings/desktop-settings-service.ts`.
- General settings UI composition: `apps/desktop/src/renderer/src/features/settings/GeneralSettings.tsx`, `apps/desktop/src/renderer/src/features/settings/__tests__/settings-screen.test.tsx`.
- Turn/event lifecycle signals: `apps/desktop/src/main/app-server/backend-registry.ts`, `packages/shared/src/contracts/normalized-app-server.ts`.
- Existing pending-attention classification: `apps/desktop/src/renderer/src/lib/useThreadSessionState.ts` (`isApprovalRequestNotification`, `isRequestUserInputNotification`).

### Institutional Learnings

- Reuse existing settings contract/update patterns rather than introducing parallel config channels.

### External References

- None required; behavior is internal and grounded in existing desktop/Electron patterns.

---

## Key Technical Decisions

- Centralize notification eligibility and dedupe in main process to avoid duplicate firing across renderer state transitions.
- Persist only user preference in settings; treat OS permission status as runtime state surfaced in settings UI.
- Use waiting-turn key as dedupe identity for attention-required notifications and clear dedupe on user action/turn termination.
- Gate all notification emission on app window state (`unfocused` or `minimized`) plus opt-in enabled.

---

## Open Questions

### Resolved During Planning

- Should approval requests trigger native notifications? Yes, explicitly required by R5 and covered by AE2.
- Should terminal outcomes be limited to success? No, all outcomes notify (R7).

### Deferred to Implementation

- Exact notification title/body strings for attention-required versus terminal outcomes.
- Exact UI copy and placement for permission-denied guidance in General Settings.

---

## Implementation Units

- U1. **Extend settings contract and persisted config for native notifications**

**Goal:** Introduce a single persisted global preference for desktop notifications under General settings.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `packages/shared/src/contracts/settings.ts`
- Modify: `packages/shared/src/contracts/__tests__/settings.test.ts`
- Modify: `apps/desktop/src/main/settings/desktop-config.ts`
- Modify: `apps/desktop/src/main/settings/desktop-settings-service.ts`
- Test: `apps/desktop/src/main/__tests__/desktop-settings-service.test.ts`

**Approach:**
- Add a `general.notifications.enabled` (or equivalent single boolean under `general`) settings value with default `false`.
- Wire read/write/patch paths so the value survives round-trips and source attribution matches existing settings conventions.

**Patterns to follow:**
- Existing `general.developerMode` and `general.messagingAcknowledgment` settings handling.

**Test scenarios:**
- Happy path: unset config reads as notifications disabled by default.
- Happy path: writing enabled true persists and reads back true.
- Edge case: unrelated settings patch does not mutate notifications value.
- Integration: env-less startup reads persisted notifications state through settings service snapshot.

**Verification:**
- Snapshot includes the notifications preference with correct value/source after read and write.

---

- U2. **Add General Settings UI toggle and permission-state affordance**

**Goal:** Expose a single user-facing notifications toggle in General Settings and show denied permission state without auto-disabling.

**Requirements:** R1, R3, R4

**Dependencies:** U1

**Files:**
- Modify: `apps/desktop/src/renderer/src/features/settings/GeneralSettings.tsx`
- Modify: `apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx`
- Modify: `apps/desktop/src/renderer/src/lib/desktop-api.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/shared/ipc.ts`
- Test: `apps/desktop/src/renderer/src/features/settings/__tests__/settings-screen.test.tsx`

**Approach:**
- Add a General Settings field that toggles the persisted notifications setting.
- Add runtime permission status fetch/request plumbing via IPC and render a visible denied state while keeping toggle enabled.
- Keep UI behavior explicit: enabled preference reflects user intent; permission warning reflects runtime capability.

**Patterns to follow:**
- General settings toggle wiring and settings save patterns.
- Existing runtime-status warning patterns from settings sections.

**Test scenarios:**
- Happy path: toggling ON writes config patch for notifications enabled.
- Happy path: toggling OFF writes config patch false.
- Error path: permission denied after enable shows visible warning but toggle remains ON. Covers AE1.
- Edge case: permission transitions from denied to granted clears denied warning without mutating toggle.

**Verification:**
- General Settings consistently reflects persisted preference and current permission status.

---

- U3. **Implement main-process native notification service and app-state gating**

**Goal:** Create a notification coordinator that enforces opt-in and `unfocused/minimized` gating before emitting native notifications.

**Requirements:** R3, R8

**Dependencies:** U1

**Files:**
- Create: `apps/desktop/src/main/notifications/desktop-notification-service.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/window-open-settings.ts`
- Test: `apps/desktop/src/main/__tests__/desktop-notification-service.test.ts`

**Approach:**
- Encapsulate permission request/status and emission checks in a main-process service.
- Service API accepts notification events and current app-window state, returning no-op when gated out.

**Patterns to follow:**
- Existing main-process service patterns with dedicated test coverage.

**Test scenarios:**
- Happy path: emits native notification when enabled and app unfocused.
- Happy path: emits native notification when enabled and app minimized.
- Edge case: does not emit while app focused. Covers R8.
- Error path: denied permission yields no emission and surfaces denied runtime state.

**Verification:**
- Main-process notification service deterministically gates emission by focus/minimize and permission state.

---

- U4. **Wire attention-required event notifications with one-shot dedupe**

**Goal:** Trigger native notifications for approval and user-input requests, deduped to one notification per unresolved waiting turn.

**Requirements:** R5, R6, R8

**Dependencies:** U3

**Files:**
- Modify: `apps/desktop/src/main/app-server/backend-registry.ts`
- Modify: `apps/desktop/src/main/codex-app-server/client.ts`
- Modify: `apps/desktop/src/renderer/src/lib/useThreadSessionState.ts` (if needed only for lifecycle-clear signaling)
- Test: `apps/desktop/src/main/__tests__/backend-registry.test.ts`
- Test: `apps/desktop/src/renderer/src/lib/__tests__/useThreadSessionState.test.tsx`

**Approach:**
- Hook notification emission at the point where approval and request_user_input events become known in the app lifecycle.
- Track unresolved waiting-turn identities and suppress repeat notifications until cleared by user action or terminal turn event.
- Explicitly include approval requests in eligibility (non-negotiable requirement).

**Patterns to follow:**
- Existing waiting-for-approval and pending-user-input classification logic.

**Test scenarios:**
- Happy path: approval request on unfocused app emits one native notification. Covers AE2.
- Happy path: request_user_input emits one native notification.
- Edge case: repeated approval events for same unresolved turn do not emit additional notifications.
- Integration: resolving approval clears dedupe state so a future waiting turn can notify again.

**Verification:**
- Attention-required notifications are emitted once per unresolved waiting turn and include approval flows.

---

- U5. **Wire terminal outcome notifications and end-to-end regression coverage**

**Goal:** Emit notifications for completed/failed/cancelled terminal outcomes under gating rules and verify end-to-end behavior.

**Requirements:** R7, R8

**Dependencies:** U3, U4

**Files:**
- Modify: `apps/desktop/src/main/app-server/backend-registry.ts`
- Modify: `packages/shared/src/contracts/normalized-app-server.ts` (only if event typing updates needed)
- Test: `apps/desktop/src/main/__tests__/backend-registry.test.ts`
- Test: `apps/desktop/src/renderer/src/__tests__/app-shell.test.tsx`

**Approach:**
- Subscribe to existing terminal lifecycle events (`turn/completed`, `turn/failed`, `turn/cancelled`) and emit native notifications through the centralized service.
- Ensure terminal notifications remain subject to same opt-in and app-state gating.

**Patterns to follow:**
- Existing terminal turn event handling and navigation refresh patterns.

**Test scenarios:**
- Happy path: turn completed while minimized emits terminal notification.
- Happy path: turn failed while unfocused emits terminal notification. Covers AE3.
- Happy path: turn cancelled while unfocused emits terminal notification.
- Edge case: no terminal notification while focused.
- Integration: attention dedupe state is cleared on terminal event finalization.

**Verification:**
- All terminal outcomes emit notifications when inactive and never emit while focused.

---

## System-Wide Impact

- **Interaction graph:** Settings (renderer) <-> IPC/preload <-> main notification service <-> backend lifecycle event stream.
- **Error propagation:** Permission-denied and emission failures should not break turn execution; they surface as settings/runtime status only.
- **State lifecycle risks:** Dedupe key leaks (never cleared) could suppress future notifications; clear paths must include approval resolution and terminal events.
- **API surface parity:** No change to external messaging adapters; change is desktop-native only.
- **Integration coverage:** Requires main+renderer tests to validate setting, event detection, and emission gating in combination.
- **Unchanged invariants:** Existing in-thread pending approval UI remains unchanged; this feature adds out-of-focus native notification layer.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Duplicate notifications due to repeated lifecycle events | Centralize one-shot dedupe by waiting-turn identity and test repeats explicitly |
| Silent failure when permission denied | Keep toggle intent enabled and render explicit denied warning in General Settings |
| Incorrect focus-state detection across windows | Gate with explicit BrowserWindow focus/minimized checks and cover with targeted unit tests |

---

## Documentation / Operational Notes

- Update desktop settings documentation to include notifications toggle semantics and permission-denied behavior.
- Add short note in user-facing settings help about inactive-window-only delivery.

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-05-28-desktop-native-attention-notifications-requirements.md`
- Related code: `apps/desktop/src/renderer/src/features/settings/GeneralSettings.tsx`
- Related code: `apps/desktop/src/main/app-server/backend-registry.ts`
