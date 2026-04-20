---
date: 2026-04-20
topic: desktop-provider-thread-model-selectors
---

# Desktop Provider And Thread Model Selectors

## Problem Frame

The desktop composer already owns setup controls below the message entry area, but provider and model-configuration ownership are split awkwardly. New chats do not yet expose a composer-owned provider selector for choosing Grok versus OpenAI, while model, reasoning, and fast-mode controls are currently scoped only to unsent launchpads instead of remaining available on existing threads.

That leaves two problems. First, new-chat setup is harder to understand because provider choice is separated from the rest of the model controls. Second, existing threads cannot keep their own model, reasoning, and fast-mode defaults for future turns even when those preferences should vary by thread. The result is a setup flow that feels inconsistent and makes thread-specific working styles harder to preserve.

| Composer state | Provider selector | Model selector | Reasoning selector | Fast selector |
| --- | --- | --- | --- | --- |
| New chat / unsent launchpad | Editable | Editable | Editable when supported | Editable when supported |
| Existing thread | Fixed to the thread's provider | Editable | Editable when supported | Editable when supported |

## Requirements

**Composer Placement And Ownership**
- R1. Provider, model, reasoning, and fast-mode controls live in the existing composer settings area below the chat entry, alongside the other setup controls already shown there.
- R2. New-chat setup treats the composer-area controls as the authoritative place to review and edit provider and model configuration before first send.
- R3. If another entrypoint preselects a backend before the draft opens, that value may seed the new-chat draft, but the composer-area provider selector must remain editable until the first message is sent.

**New Chat Provider Selection**
- R4. New chats expose a provider selector next to, or immediately to the left of, the model and reasoning controls.
- R5. The new-chat provider selector uses user-facing provider labels `Grok` and `OpenAI`, even if the internal backend identifiers differ.
- R6. Changing the provider on a new chat updates the available model, reasoning, and fast-mode choices to the selected provider's supported set.
- R7. Changing provider, model, reasoning, or fast mode on a new chat updates the sticky defaults used for future new chats, but does not rewrite existing threads.
- R8. After the first send, the thread's provider is fixed; existing threads do not allow switching between Grok and OpenAI.

**Existing Thread Controls**
- R9. Existing threads show model, reasoning, and fast-mode controls in the same composer settings area below the chat entry.
- R10. Existing-thread model, reasoning, and fast-mode controls are scoped to that thread's fixed provider and only show options supported by that provider and selected model.
- R11. When a user changes model, reasoning, or fast mode on an existing thread, the change becomes that thread's saved default for the next turn, not a retroactive change to prior turns.
- R12. Existing-thread model, reasoning, and fast-mode preferences persist across navigation and app restart.
- R13. Changing model, reasoning, or fast mode on one thread must not change those settings for any other thread.

**Capability-Driven Availability**
- R14. The model selector is provider-specific and only shows models advertised as valid for the selected provider or thread provider.
- R15. The reasoning selector only appears when the selected provider/model combination advertises reasoning support.
- R16. The fast selector only appears when the selected provider/model combination advertises fast-mode support.
- R17. The desktop UI must not hard-code speculative compatibility rules such as "only one named OpenAI model supports fast mode" when backend metadata can provide the supported set.
- R18. If a previously saved model, reasoning, or fast-mode value is no longer supported for that provider or model, the composer falls back to a valid default without breaking send.

**Thread-Scoped Safety**
- R19. Before shipping existing-thread selectors, the implementation must verify that the JSON-RPC path used for model, reasoning, and fast-mode updates is thread-scoped and does not cause sibling threads on the same backend session to inherit the change.
- R20. If the backend cannot safely honor a thread-scoped value for one of these controls, that control must not present a misleading editable state for existing threads.

## Success Criteria

- Users can start a new chat and choose `Grok` or `OpenAI` from the same composer control cluster as model and reasoning.
- Existing threads preserve their own model, reasoning, and fast-mode defaults for future turns.
- Changing thread settings on one thread does not alter the behavior of other threads.
- Unsupported controls cleanly disappear or reset to valid defaults when provider or model capabilities change.
- The composer feels consistent because setup ownership lives with the reply workflow rather than being split across unrelated surfaces.

## Scope Boundaries

- This change does not allow switching an existing thread from Grok to OpenAI or from OpenAI to Grok after the first send.
- This change does not require historical turns to be relabeled or replayed with newly chosen settings.
- This change does not require a service-tier selector redesign in the existing-thread composer as part of this pass.
- This change does not promise any specific OpenAI fast-mode compatibility list unless the backend metadata explicitly advertises it.

## Key Decisions

- Hybrid ownership: provider is a new-chat decision, while model/reasoning/fast remain adjustable per thread after creation.
- Next-turn semantics: existing-thread selector changes become saved defaults for subsequent turns rather than mutating already-sent turns.
- Capability-driven UI: provider/model compatibility governs which controls appear, rather than static frontend assumptions.
- Provider-first labeling: new-chat backend choice should be expressed in user-facing provider terms (`Grok`, `OpenAI`) instead of transport-oriented internal names.

## Dependencies / Assumptions

- The app-server's thread-scoped resume/update path continues to target an individual `threadId` rather than mutating backend-global defaults.
- Backend metadata can advertise enough provider/model capability detail to drive model, reasoning, and fast-mode visibility accurately.
- The desktop product can add thread-level persistence for model, reasoning, and fast-mode defaults even if one backend currently treats some of those values as session-oriented internally.

## Outstanding Questions

### Deferred to Planning
- [Affects R9-R13][Technical] What desktop API and persistence path should store existing-thread model, reasoning, and fast-mode defaults, given that current thread overlay state only persists execution mode?
- [Affects R15-R17][Technical] How should backend summaries expose provider/model capability metadata in live desktop runtime so the composer can render real supported options instead of test-only mock data?
- [Affects R16-R20][Technical] What thread-scoped request shape should carry fast mode for existing threads when the current desktop `turn/start` path only forwards `model` and current thread state does not yet persist `fastMode`?

## Next Steps

-> `/prompts:ce-plan` for structured implementation planning
