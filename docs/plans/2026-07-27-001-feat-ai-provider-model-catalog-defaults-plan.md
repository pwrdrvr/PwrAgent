---
title: AI Provider Model Catalog And Defaults - Plan
type: feat
date: 2026-07-27
topic: ai-provider-model-catalog-defaults
artifact_contract: ce-unified-plan/v1
artifact_readiness: requirements-only
product_contract_source: ce-brainstorm
execution: code
---

# AI Provider Model Catalog And Defaults - Plan

## Goal Capsule

- **Objective:** Give each PwrAgent profile a trustworthy provider model catalog and explicit model/reasoning baselines without erasing thread, launchpad, or learned provider choices.
- **Product authority:** AI Providers owns discovered provider capabilities and durable baselines; the composer remains authoritative for a thread or launchpad's specific setup.
- **Open blockers:** None.

---

## Product Contract

### Summary

AI Providers will expose current discovered models and effort/thinking options for every enabled provider that advertises them.
Users can choose provider-specific model and per-model reasoning baselines, reset to provider recommendations, and deliberately adopt a new baseline across matching unsent launchpads.

### Problem Frame

Learned launchpad choices make repeated work convenient, but they also preserve stale choices indefinitely.
A user who now prefers GPT-5.6-Sol with high reasoning can still find GPT-5.5 snapshotted into every directory launchpad, while switching models or providers can restore an unwanted reasoning level.

Provider catalogs also change independently of PwrAgent.
An installed ACP provider may expose new models and thinking options after it updates, while PwrAgent continues showing a cached catalog until discovery is triggered.
A Settings default is only trustworthy when the catalog behind it is fresh, capability-driven, and honest about failures.

### Key Decisions

- **One provider catalog and defaults outcome.** (session-settled: user-directed — chosen over defaults with discovery as separate prerequisite: users need one trustworthy place to see current choices and configure them.) Governs R1-R8.
- **Layered baseline instead of hard enforcement.** (session-settled: user-directed — chosen over Settings overriding learned choices: specific thread, draft, and provider context must remain authoritative.) Governs R13-R16.
- **Per-profile, per-provider, per-model scope.** (session-settled: user-directed — chosen over installation-wide, Codex-auth-profile, and provider-wide reasoning defaults: the scope must work consistently across built-in and ACP providers.) Governs R9-R12.
- **Lazy catalog refresh with manual control.** (session-settled: user-directed — chosen over probing every enabled provider at startup: unused third-party executables should not launch merely because PwrAgent started.) Governs R3-R6.
- **Suspend invalid preferences instead of deleting them.** (session-settled: user-directed — chosen over clearing preferences on capability drift: temporary provider changes should not destroy intent.) Governs R17-R19.
- **Confirmed bulk adoption.** (session-settled: user-directed — chosen over silent automatic rewrites and one-directory-at-a-time reset: users need a deliberate way to replace stale launchpad baselines at scale.) Governs R20-R23.
- **Catalog required for a first launch.** (session-settled: user-directed — chosen over launching with an unknown provider default: a provider with no previously valid catalog must discover successfully before creating a thread.) Governs R7-R8.

<!-- ce-section: work-relationships -->
### How This Work Fits Together

This plan owns the AI Providers catalog, explicit model/reasoning baselines, and deliberate launchpad migration as one product outcome.
The surrounding relationships are current context, not a committed roadmap:

- **Can proceed independently of:** the sibling provider-stickiness bug fix, which preserves learned launchpad settings across provider switches.
- **Shares behavior with:** composer model/reasoning controls and provider-specific sticky state, whose precedence this plan defines but whose unrelated behavior is not redesigned here.
- **Does not own:** provider executable upgrades or self-update behavior; PwrAgent responds by rediscovering capabilities.

### Requirements

**Provider catalog**

- R1. AI Providers must show a model catalog for every enabled provider that advertises discoverable model choices.
- R2. Each catalog must expose the provider-advertised model label, valid effort/thinking options, current effective recommendation, and availability needed to choose a valid baseline.
- R3. AI Providers must show cached catalog data immediately while communicating whether it is current, refreshing, stale, unavailable, or failed.
- R4. PwrAgent must refresh an enabled provider's catalog when AI Providers opens and the first time that provider is selected during each app session.
- R5. Users must be able to force a provider catalog refresh and retry a failed refresh.
- R6. Catalog refresh must update newly added, removed, and changed model and effort/thinking choices without requiring an app restart.
- R7. A failed refresh with a previously valid catalog must preserve that catalog as visibly stale and keep it usable for new launchpads.
- R8. A provider with no previously valid catalog must not create a new thread until discovery succeeds; discovery failure must not invalidate existing threads.

**Explicit baselines**

- R9. Model and reasoning baselines must be scoped to the active PwrAgent profile.
- R10. Every provider covered by R1 must allow the user to choose one default model from its valid catalog.
- R11. Every reasoning-capable model must allow its own effort/thinking baseline from the options valid for that model.
- R12. Execution/access mode, Fast/service tier, Codex Environment, and other launch settings must remain outside this Settings baseline and retain their existing composer-owned behavior.
- R13. Effective model and reasoning values must resolve in this order: restored thread state, current directory launchpad snapshot, learned per-provider sticky choice, Settings baseline, then provider-advertised recommendation.
- R14. A Settings baseline must seed provider contexts with no higher-precedence choice and serve as the target of an explicit composer reset.
- R15. Changing a Settings baseline alone must not rewrite learned provider choices, unsent launchpads, or existing threads.
- R16. Resetting a launchpad to its configured baseline must update that launchpad and the provider's future sticky model/reasoning choice without changing other launchpads or existing threads.

**Capability drift and reset**

- R17. If a saved default model becomes unavailable, PwrAgent must retain it as a suspended preference while using the current provider-advertised recommendation.
- R18. If a saved effort/thinking value becomes invalid or its model stops advertising reasoning, PwrAgent must retain it as a suspended preference while using the model's current advertised recommendation.
- R19. A suspended preference must resume when it becomes valid again, while Reset in AI Providers must discard explicit model and reasoning preferences and follow the provider recommendation.

**Adopt a new baseline**

- R20. AI Providers must offer an explicit action to apply the configured baseline to all unsent launchpads currently using that provider.
- R21. The bulk action must show the number of affected launchpads and require confirmation before applying.
- R22. A confirmed bulk action must update model and reasoning on every matching launchpad and replace the provider's learned sticky model/reasoning choice for future launchpads.
- R23. A confirmed bulk action must preserve prompt text, attachments, workspace mode, branch, access mode, Fast/service tier, Codex Environment, and every existing thread.

The precedence defined by R13 is the normal resolution path:

```mermaid
flowchart TB
  A[Restored thread state] -->|absent| B[Directory launchpad snapshot]
  B -->|absent| C[Learned provider sticky choice]
  C -->|absent| D[AI Providers baseline]
  D -->|absent or suspended| E[Provider-advertised recommendation]
```

### Key Flows

- F1. Inspect and configure a provider
  - **Trigger:** The operator opens AI Providers.
  - **Steps:** PwrAgent shows cached catalogs, refreshes enabled providers, surfaces freshness or errors, and allows valid model and per-model reasoning selections.
  - **Outcome:** The PwrAgent profile has an explicit baseline backed by a visible provider catalog.
  - **Covered by:** R1-R12.
- F2. Open or switch a launchpad
  - **Trigger:** The operator opens a directory launchpad or switches its provider.
  - **Steps:** PwrAgent refreshes the provider on its first selection for the session and resolves model/reasoning through R13.
  - **Outcome:** The most specific valid choice is restored without losing another provider's learned settings.
  - **Covered by:** R4, R7-R8, R13-R19.
- F3. Adopt a new baseline across projects
  - **Trigger:** The operator chooses the bulk action for a configured provider baseline.
  - **Steps:** PwrAgent shows the affected count, obtains confirmation, updates every matching unsent launchpad, and adopts the baseline for future provider stickiness.
  - **Outcome:** Stale project launchpads move together while their prompts and unrelated setup remain intact.
  - **Covered by:** R20-R23.
- F4. Handle catalog drift
  - **Trigger:** Refresh adds, removes, or changes a provider model or effort option.
  - **Steps:** PwrAgent updates the catalog, suspends invalid explicit preferences, and resolves an effective valid recommendation.
  - **Outcome:** New launches remain valid without silently destroying the user's saved intent.
  - **Covered by:** R3-R8, R17-R19.

### Acceptance Examples

- AE1. New PwrAgent profile
  - **Covers R3-R14.**
  - **Given:** A new profile has no learned provider choice or explicit baseline.
  - **When:** The operator selects a provider with a valid discovered catalog.
  - **Then:** The launchpad uses the provider-advertised model and effort recommendation.
- AE2. Explicit Codex baseline survives restart
  - **Covers R9-R15.**
  - **Given:** The operator selects GPT-5.6-Sol with high reasoning in AI Providers and no higher-precedence Codex choice exists.
  - **When:** PwrAgent restarts and the operator opens a fresh Codex launchpad.
  - **Then:** GPT-5.6-Sol with high reasoning is selected.
- AE3. Existing sticky history remains specific
  - **Covers R13-R16.**
  - **Given:** Codex sticky history contains GPT-5.5 while Settings now names GPT-5.6-Sol with high reasoning.
  - **When:** The operator opens a fresh Codex launchpad without resetting or bulk-adopting the new baseline.
  - **Then:** The sticky GPT-5.5 choice remains authoritative.
- AE4. Provider and model switching restores reasoning
  - **Covers R11, R13-R16.**
  - **Given:** Codex remembers GPT-5.6-Sol with high reasoning and GPT-5.6-Terra with a different effort, while another provider has its own choices.
  - **When:** The operator switches providers and then switches between the two Codex models.
  - **Then:** Each provider and model restores its own learned reasoning choice.
- AE5. Bulk adoption replaces stale launchpads
  - **Covers R20-R23.**
  - **Given:** Multiple unsent Codex directory launchpads contain GPT-5.5 and may contain prompts or unrelated setup choices.
  - **When:** The operator confirms applying GPT-5.6-Sol with high reasoning to all Codex launchpads.
  - **Then:** Every unsent Codex launchpad and future Codex sticky choice uses GPT-5.6-Sol with high reasoning, while prompts, unrelated setup, and existing threads are unchanged.
- AE6. Configured model disappears and returns
  - **Covers R6-R8, R17, R19.**
  - **Given:** A refreshed valid catalog no longer advertises the configured default model.
  - **When:** The operator creates a new launchpad and the model later reappears in a successful refresh.
  - **Then:** PwrAgent first uses the provider recommendation while showing the saved model as suspended, then resumes the saved model after it becomes valid again.
- AE7. Reasoning option changes
  - **Covers R11, R18-R19.**
  - **Given:** A model's saved reasoning effort is no longer advertised.
  - **When:** The operator uses that model.
  - **Then:** PwrAgent uses the model's advertised reasoning recommendation while retaining the saved effort as suspended until it returns or the operator resets it.
- AE8. Discovery failure with and without cache
  - **Covers R3-R8.**
  - **Given:** One provider has a previously valid cached catalog and another has never discovered successfully.
  - **When:** Both providers fail their first-selection refresh.
  - **Then:** The cached provider remains available with a stale warning, while the never-discovered provider blocks new thread creation and offers retry.
- AE9. Existing thread restoration
  - **Covers R8, R13, R15, R23.**
  - **Given:** A thread was created with a model/reasoning combination that differs from current Settings and sticky choices.
  - **When:** The thread is restored after navigation, restart, a Settings change, or bulk adoption.
  - **Then:** Its saved thread settings remain authoritative and unchanged.

### Scope Boundaries

- This work does not upgrade, install, or control self-update behavior for provider executables.
- This work does not mutate existing thread settings or historical turns.
- This work does not make Settings authoritative over restored threads, directory launchpad snapshots, or learned provider choices outside explicit reset and bulk actions.
- This work does not add Settings defaults for execution/access mode, Fast/service tier, Codex Environment, workspace mode, or branch.
- This work does not hard-code provider model compatibility or promise a model list for providers that expose no discoverable catalog.
- This work does not move defaults into Codex auth-profile or installation-global scope.
- This work does not expand the sibling provider-stickiness fix.

### Dependencies / Assumptions

- Providers expose enough capability metadata to identify valid models, effort/thinking options, and a current recommendation.
- PwrAgent can distinguish a previously valid catalog from an absent or unusable discovery result.
- Unsent launchpads can be enumerated by provider without treating existing threads as migration targets.
- Provider discovery may launch third-party executables, so refresh must remain visible, bounded, and user-retryable.

### Outstanding Questions

#### Deferred to Planning

- Which existing discovery lifecycle should own first-selection refresh so desktop, messaging, and Settings consume one catalog result?
- How should planning distinguish provider-advertised current/default choices from fallback ordering when providers expose incomplete metadata?
- How should refresh work be coalesced and bounded so opening AI Providers or selecting a provider cannot launch duplicate probes?
- What verification strategy proves that bulk adoption changes only model/reasoning and never prompt or unrelated launchpad state?

### Sources / Research

- `apps/desktop/src/renderer/src/features/settings/ModelsSettings.tsx`
- `apps/desktop/src/renderer/src/features/settings/AcpAgentsSettings.tsx`
- `packages/shared/src/contracts/settings.ts`
- `packages/shared/src/contracts/navigation.ts`
- `packages/shared/src/contracts/backend.ts`
- `apps/desktop/src/main/state/overlay-store-sqlite.ts`
- `apps/desktop/src/main/app-server/backend-registry.ts`
- `docs/brainstorms/2026-04-30-desktop-settings-config-requirements.md`
- `docs/brainstorms/2026-04-20-desktop-provider-thread-model-selectors-requirements.md`
- `docs/brainstorms/2026-04-18-directories-launchpad-requirements.md`
- `docs/plans/2026-05-21-001-feat-acp-runtime-capability-discovery-plan.md`
- `docs/plans/2026-06-05-001-feat-acp-durable-capability-cache-plan.md`
