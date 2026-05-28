---
date: 2026-05-28
topic: desktop-native-attention-notifications
---

# Desktop Native Attention Notifications

## Problem Frame

Users multitask while turns run and do not want to poll PwrAgent to see whether action is needed. PwrAgent needs an opt-in native notification behavior that alerts users when attention is required (approval/questions) and when turns finish, without spamming while the app is already in focus.

---

## Actors

- A1. Desktop operator: Enables or disables notifications and acts on prompted tasks.
- A2. PwrAgent desktop app: Detects eligible events and emits native notifications.
- A3. Operating system notification service: Grants or denies notification permission and delivers toasts/banners.

---

## Key Flows

- F1. Opt in to notifications
  - **Trigger:** User enables notifications in General Settings.
  - **Actors:** A1, A2, A3
  - **Steps:** User toggles setting on; app checks/requests OS notification permission; app stores enabled preference; app surfaces granted/denied state.
  - **Outcome:** Notifications are enabled for eligible events, or enabled state remains with explicit denied warning.
  - **Covered by:** R1, R2, R3

- F2. Attention-required event while app is not active
  - **Trigger:** A turn emits a request requiring user input/approval while app is minimized or unfocused.
  - **Actors:** A2, A3
  - **Steps:** App evaluates event type and window focus/minimize status; emits one native notification for that waiting turn; suppresses repeats for the same waiting turn until user action resolves it.
  - **Outcome:** User receives a single actionable attention alert instead of repeated prompts.
  - **Covered by:** R4, R5, R6

- F3. Turn terminal event while app is not active
  - **Trigger:** A turn ends in completed, failed, or canceled state while app is minimized or unfocused.
  - **Actors:** A2, A3
  - **Steps:** App detects terminal event and emits native notification if notifications are enabled.
  - **Outcome:** User is informed that turn work ended regardless of outcome.
  - **Covered by:** R7, R8

---

## Requirements

**General setting and consent**
- R1. General Settings includes a single desktop-native notifications control with enabled/disabled states.
- R2. Notifications are default-off and require explicit user opt-in.
- R3. Enabling notifications must handle OS permission flow and expose resulting permission state in the UI.

**Permission-denied behavior**
- R4. If OS permission is denied, the notification toggle remains enabled (user intent preserved) and the UI shows a visible “permission denied” state with guidance to OS settings.

**Event eligibility and delivery**
- R5. PwrAgent emits native notifications for events requiring user action, including approval requests and user-input questions.
- R6. For a single waiting turn, only one attention-required native notification is emitted until the user acts (no reminder cadence by default).
- R7. PwrAgent emits native notifications for all turn terminal outcomes: completed, failed, and canceled.
- R8. Native notifications for R5-R7 only fire when PwrAgent is minimized or unfocused; no native notification fires while PwrAgent is focused.

---

## Acceptance Examples

- AE1. **Covers R4.** Given notifications are toggled on and OS permission is denied, when the settings screen refreshes, the toggle remains on and a visible permission-denied warning is shown.
- AE2. **Covers R5, R6, R8.** Given notifications are enabled and the app is unfocused, when a turn asks for approval twice without user action, one native notification is delivered for that waiting turn.
- AE3. **Covers R7, R8.** Given notifications are enabled and the app is minimized, when a turn fails, one terminal native notification is delivered.

---

## Success Criteria

- Users can rely on native notifications instead of periodically checking the app for attention-needed and turn-end events.
- Planning and implementation can proceed without inventing product behavior for opt-in, permission-denied handling, delivery gating, or terminal outcome coverage.

---

## Scope Boundaries

- No notification reminder cadence or escalation policy in v1 (single-shot per waiting turn only).
- No in-app focused-state toasts replacing native notifications in this feature.
- No per-event-type granularity in settings beyond one global native notifications control.

---

## Key Decisions

- Delivery gating: Notify only when minimized or unfocused, never while focused.
- Attention semantics: Both “needs user action” and “turn is over” are in-scope.
- Waiting-turn behavior: Single notification per unresolved waiting turn is sufficient.
- Terminal outcomes: Completed, failed, and canceled all notify.
- Permission-denied UX: Preserve enabled intent and show visible denied state rather than auto-disabling.

---

## Dependencies / Assumptions

- OS-native notification APIs are available through the desktop runtime and can report permission status.
- “User attention required” event classes can be detected from existing turn/notification event streams.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] Exact wording and placement of the permission-denied guidance in General Settings.
- [Affects R5, R7][Technical] Notification content template (title/body) for attention-required vs terminal outcomes.

---

## Next Steps

-> /ce-plan for structured implementation planning
