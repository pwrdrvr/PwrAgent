---
date: 2026-05-22
topic: messaging-new-thread-backend-selection
---

# Messaging New Thread Backend Selection

## Problem Frame

Messaging users can now start a thread directly with `/new`, but the new-thread
flow still treats backend selection as an invisible launchpad default. That was
acceptable when one backend was effectively usable from messaging, but it breaks
down as PwrAgent grows from Codex and Grok toward additional ACP-backed agents
such as Gemini.

The desktop launchpad already treats backend, model, reasoning, fast mode, and
related controls as pre-thread settings. Messaging should follow that product
model: start from the same sticky launchpad defaults, let the user change the
backend before the first prompt, adapt the remaining option buttons to that
backend's capabilities, then freeze the backend once the thread exists.

| Flow state | Backend control | Model/settings controls | Backend shown after creation |
| --- | --- | --- | --- |
| One usable backend | Hidden; selected silently | For that backend only | Status card |
| Multiple usable backends | Editable before first prompt | Recomputed after backend changes | Status card |
| Existing/resumed thread | Not editable | Thread-scoped settings only | Status card |

## Requirements

**Backend Choice Before Thread Creation**
- R1. `/new`, the New help action, and the supported `/resume --new` compatibility path must use the same backend-selection behavior.
- R2. If zero backends are currently usable for creating a thread, messaging must present a recoverable error instead of continuing into a misleading project or prompt flow.
- R3. If exactly one backend is usable for creating a thread, messaging must select it silently and avoid presenting a backend button or chooser.
- R4. If two or more backends are usable for creating a thread, messaging must show an editable backend/provider control in the new-thread options surface before the first prompt is sent.
- R5. The initial selected backend must come from the same sticky launchpad default the desktop launchpad would use, falling back to a valid create-capable backend if that default is unavailable.
- R6. Changing the backend in messaging must update the pending new-thread session only; it must not switch any existing thread.

**Capability-Driven Options**
- R7. The Model, Reasoning, Fast, permissions, workspace, and any service-tier or future option buttons shown in the messaging new-thread options surface must reflect the currently selected backend's capabilities.
- R8. When the user changes backend, messaging must recompute available models and other backend-specific controls for the newly selected backend.
- R9. If the previous pending model or option value is not valid for the newly selected backend, messaging must fall back to that backend's valid default rather than carrying an incompatible value forward.
- R10. Messaging must avoid showing option buttons that imply unsupported behavior for the selected backend.
- R11. ACP/Gemini must fit this selection model as another backend/provider when it becomes available, but this brainstorm does not define ACP's final internal request shape.

**Thread Creation And Immutability**
- R12. Thread creation from messaging must use the backend selected in the pending new-thread session, not blindly use the global launchpad default.
- R13. Directory launchpad materialization from messaging must preserve the selected backend and selected backend-specific settings.
- R14. Once the first prompt creates the thread, the backend/provider control disappears; backend switching is not available for existing threads.
- R15. Existing thread status cards must continue to identify which backend/provider owns the thread, using user-facing labels as they become available.

**Launchpad Default Parity**
- R16. Messaging must read the same sticky launchpad defaults used by the desktop launchpad for backend, model, reasoning, fast mode, service tier, and workspace mode.
- R17. A backend change made inside a pending messaging new-thread flow should become the user's new sticky launchpad default if the desktop launchpad would treat the same change as sticky.
- R18. Sticky-default writes must happen only for pre-thread launchpad choices, not for existing thread status-card changes.

**Messaging Surface Behavior**
- R19. Backend selection must be represented in channel-neutral messaging intents and actions, with provider adapters only rendering according to their capability profile.
- R20. Text fallback must remain usable on providers with limited or no button support, so a user can still identify and choose among available backends.
- R21. Pagination and action counts must respect the connected messaging provider's capability profile; adding backend choices must not make the new-thread options surface exceed provider limits.
- R22. Authorization and browse-session scoping must remain unchanged: backend choices must not reveal projects, threads, or capabilities to unauthorized actors.

## Success Criteria

- A messaging user running `/new` sees the same default backend they would get from the desktop launchpad.
- When more than one create-capable backend is available, the user can change backend before sending the first prompt.
- Changing backend updates model/reasoning/fast availability before thread creation.
- The created thread is bound to the selected backend, and the status card identifies that backend afterward.
- No existing thread can be switched between Codex, Grok, Gemini, or any future backend through this flow.

## Scope Boundaries

- In scope: new-thread backend selection for messaging surfaces before first prompt.
- In scope: launchpad-default parity for pre-thread backend and model settings.
- In scope: retaining `/resume --new` compatibility while treating `/new` as the primary command.
- Out of scope: switching the backend of an existing thread.
- Out of scope: final ACP/Gemini protocol shape, beyond ensuring the selection model can accept additional backend kinds.
- Out of scope: redesigning the desktop launchpad UI.
- Out of scope: provider-specific messaging branches for Telegram, Discord, Slack, Mattermost, LINE, or Feishu.

## Key Decisions

- Editable launchpad option, not mandatory first step: the old issue proposed a backend chooser before project selection, but the current product shape is better served by a backend button in the new-thread options surface.
- Sticky default parity: messaging should reflect and update the same launchpad defaults as desktop for pre-thread choices.
- Immutable after birth: provider/backend is a creation-time decision and becomes status-card metadata once the thread exists.
- Capability-driven controls: backend choice determines which model and settings buttons are meaningful.

## Dependencies / Assumptions

- The backend registry can report available create-capable backends and launchpad options through `BackendSummary`.
- Messaging browse sessions remain the right place to hold pending pre-thread choices until the first prompt is submitted.
- Backend labels will be user-facing enough for messaging controls; where needed, UI copy can map internal identifiers to `Codex`, `Grok`, and `Gemini`.
- ACP/Gemini work may expand the backend kind model, but this requirement only depends on messaging not assuming there are exactly two backend kinds.

## Outstanding Questions

### Resolve Before Planning

(None.)

### Deferred to Planning

- [Affects R11][Technical] How should the shared backend kind/type model evolve so messaging does not keep hard-coded `codex | grok` validation once ACP/Gemini lands?
- [Affects R17][Technical] Which messaging backend bridge call should update sticky launchpad defaults when a pre-thread backend or model choice changes?
- [Affects R20][Technical] What text fallback command syntax should select a backend on text-only or button-constrained providers?
- [Affects R21][Technical] Should backend selection live on the ready-to-start options surface only, or also be reachable from the project picker when action budgets allow?

## Next Steps

-> `/prompts:ce-plan` for structured implementation planning
