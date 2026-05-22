---
date: 2026-05-22
topic: messaging-full-access-approval
---

# Messaging Full Access Approval

## Problem Frame

Messaging new-thread startup can show Full Access as the selected launchpad
default, accept the user's first prompt, and then replace the existing
new-thread settings surface with a Full Access warning before starting the
thread. If the user returns after the browse session expires, the approval
button resolves to "Invalid selection" and the original prompt is gone.

This makes an already-approved default feel like a surprise second gate, and it
puts a new required action above the user's submitted prompt instead of in
direct response to an explicit settings-card action.

Current source observations:
- New-thread options inherit `navigation.launchpadDefaults.executionMode` when
  the session has no explicit override.
- New-thread creation checks Full Access warning acceptance after the first
  prompt is prepared, immediately before materializing the thread.
- Browse sessions and pending intents currently use a 15-minute controller TTL,
  while provider callback handles are designed for a much longer lifetime.
- Full Access warnings for new/resume browse flows target the existing session
  surface, so a text-triggered gate can rewrite an older card.

## User Flow

```mermaid
flowchart TB
  A[/new] --> B[Settings card shows inherited Full Access]
  B --> C[User sends first prompt]
  C --> D{Full Access was inherited and policy allows it?}
  D -->|yes| E[Start new thread immediately]
  D -->|no, explicit escalation requires warning| F[Show warning in response context]
  F --> G{User approves}
  G -->|yes| H[Start or return without losing the submitted intent]
  G -->|cancel| I[Do not start Full Access]
```

## Requirements

**Inherited Defaults**
- R1. A new messaging thread whose initial settings already show Full Access
  because of launchpad defaults or a directory launchpad must not require a
  second Full Access warning under the dismissable warning policy.
- R2. The `Always` warning policy remains authoritative: if the operator chose
  to warn every time, messaging must still warn even when Full Access came from
  an inherited default.
- R3. Explicit messaging escalation from Default Access to Full Access must keep
  the warning gate when the effective warning policy says to warn.

**Warning Placement**
- R4. Messaging may update an existing status/settings/picker card with a Full
  Access warning only when the warning was triggered by a callback from that
  same interactive surface.
- R5. If a text or media message triggers a Full Access interlock, messaging
  must not rewrite an older card above the user's message. It must either avoid
  the interlock through inherited-default acceptance, or post the warning as the
  direct response below the submitted message.

**Held Prompt Behavior**
- R6. If a first prompt is legitimately blocked by a Full Access warning,
  approving the warning must not discard the prompt. The system should either
  start the thread with the already-submitted prompt after approval, or clearly
  avoid accepting/holding the prompt until the warning is resolved.
- R7. Visible Full Access warning actions must not expire on the 15-minute
  browse-session TTL. They should remain valid until they are superseded,
  cancelled, or reach the same long-lived callback validity expected of other
  persistent messaging buttons.
- R8. Stale warnings, if they can still occur, must fail with copy specific to
  the Full Access warning rather than the generic resume-browser "Invalid
  selection" message.

**Regression Coverage**
- R9. Add coverage for `/new` with launchpad defaults set to Full Access and a
  dismissable warning policy: the first prompt starts a Full Access thread
  without rendering a warning.
- R10. Add coverage for text-triggered warning placement if any warning path
  remains for submitted prompts.
- R11. Add coverage that a visible Full Access warning approval does not fail
  merely because the underlying browse session aged past the current picker TTL.
- R12. Keep existing coverage for explicit Full Access escalation from a status
  or picker button, including the warning, cancel, dismiss, and policy-disabled
  cases.

## Success Criteria

- Starting a `/new` thread from an already-Full-Access launchpad default begins
  the thread on the first submitted prompt.
- Users never see a required approval card inserted above their submitted text
  unless they caused it by pressing a button on that same card.
- Clicking a visible Full Access approval after a long delay does not produce
  "Invalid selection" for the normal case.
- Explicit escalation and operator policy controls still protect Default Access
  threads from silently becoming Full Access.

## Scope Boundaries

- Do not remove the global ability to block messaging Full Access escalation.
- Do not remove the `Always` warning policy.
- Do not redesign the whole resume/new-thread browser flow.
- Do not change provider-specific callback behavior unless required to preserve
  the generic messaging contract.

## Key Decisions

- Inherited Full Access defaults under a dismissable warning policy count as
  already user-selected for new-thread startup. The product should not treat the
  first prompt as a new escalation event.
- Warning placement should follow event causality. Callback-triggered warnings
  can update the clicked surface; text-triggered warnings should respond in the
  conversation flow.
- Full Access warning approvals should not be governed by the short browse
  picker TTL. A visible safety decision should stay actionable or explain its
  invalidation precisely.

## Dependencies / Assumptions

- The operator remains responsible for deciding which messaging actors are
  authorized to use messaging at all.
- This work can be implemented inside desktop messaging orchestration and the
  generic messaging contract without adding provider-specific policy branches.
- Focused source review did not reveal another obvious path that rewrites a
  status/settings card to ask for user input in response to plain text rather
  than a card callback.

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] Determine whether the implementation should mark the
  browse session as accepted when it is created with an inherited Full Access
  default, or skip the warning check based on provenance at start time.
- [Affects R6][Technical] If any submitted-prompt warning remains, decide
  whether to persist the pending first prompt across process restart or only
  guarantee it during the current controller lifetime.
- [Affects R7][Technical] Decide whether Full Access warnings should use a
  dedicated non-expiring domain record, the long callback-handle TTL, or a
  refreshed browse-session record.

## Next Steps

-> `/prompts:ce-plan` for structured implementation planning.
