---
title: Messaging Working Updates Project Default - Plan
type: fix
date: 2026-07-17
topic: messaging-working-updates-project-default
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
product_contract_source: ce-plan-bootstrap
execution: code
---

# Messaging Working Updates Project Default - Plan

## Goal Capsule

- **Objective:** Make the Working Updates choice in messaging `/new` sticky for the selected project while retaining the top-level Messaging setting as the fallback for projects that have never chosen an override.
- **Product authority:** A messaging user should not have to change Working Updates from `Some` every time they create a thread for the same project.
- **Resolved planning decisions:** Store an explicit per-project override only after the user chooses a concrete mode in `/new`; do not add an inherit/reset option; keep the project-specific control in the messaging `/new` flow rather than adding it to the desktop launchpad UI.

## Product Contract

### Summary

Working Updates already has a top-level Messaging default and a per-binding preference. Add the missing layer between them: an optional project-specific `/new` preference that survives creating a thread and becomes the starting value for future messaging-created threads in that project.

### Problem Frame

The `/new` wizard currently initializes Working Updates from the global Messaging default and stores a selection only in the in-progress wizard session. The resulting binding receives the selection, but the selected project does not remember it. A later `/new` therefore falls back to the global default—commonly `Some`—even when the operator repeatedly chooses another mode for that project.

### Actors

- A1. **Messaging operator:** Creates threads with `/new` and chooses how much progress narration to receive.
- A2. **Project launchpad:** Holds optional project-level defaults used before a thread exists.
- A3. **Messaging binding:** Holds the effective Working Updates preference for an individual created thread.

### Requirements

- R1. An untouched project uses the current top-level Settings → Messaging Working Updates default in `/new`.
- R2. Choosing a concrete Working Updates mode in a project's messaging `/new` wizard stores that mode as the project's override.
- R3. A later messaging `/new` for the same project starts with that project override, including after the previous launchpad was materialized into a thread.
- R4. A project override affects only that project; projects without an override continue to follow the global default.
- R5. The new binding stores the effective mode chosen by the wizard. Existing bindings keep their own preference and are not changed by later global or project-default changes.
- R6. The project override remains explicit until replaced by another concrete mode. This change does not add an inherit/reset option.
- R7. The project-specific choice remains a messaging `/new` concern. This change does not add Working Updates to the desktop launchpad editor.

### Key Decisions

- **Explicit project override:** Persist a project value only after the operator selects a concrete Working Updates mode. Untouched projects inherit the live global Messaging default. `session-settled: user-directed; rejected: always copy the latest global default into every project, and require every project to have a stored value.`
- **No reset option:** The picker continues to offer only the concrete Working Updates modes; selecting a different mode replaces the project override. `session-settled: user-directed; rejected: add a Global default picker option or a separate settings-only reset control.`
- **Messaging-only project surface:** Read and write the project override through messaging `/new`; do not expose it in the desktop launchpad UI. `session-settled: user-directed; rejected: add Working Updates to the desktop launchpad or project settings surface.`

### Key Flow

- F1. **Choose and reuse a project Working Updates mode**
  - **Trigger:** The operator opens `/new`, selects a project, and chooses a Working Updates mode.
  - **Steps:** The wizard stores the concrete mode on the project's launchpad and in its current session; thread creation copies the effective mode to the new binding; launchpad reset preserves the project override; a later `/new` reads the override before falling back to the global setting.
  - **Outcome:** The project remembers the operator's choice without changing other projects or existing bindings.
  - **Covered by:** R1–R7.

### Acceptance Examples

- AE1. **Covered by R1.** Given project A has no override and the global default is `More`, when the operator opens `/new` for project A, then the wizard shows `More`.
- AE2. **Covered by R2, R3, R5.** Given the operator selects `None` for project A and creates a thread, when they later open `/new` for project A, then the wizard shows `None` and a newly created binding stores `None`.
- AE3. **Covered by R3, R4.** Given project A has a `None` override and project B has no override, when the global default changes to `More`, then project A still starts at `None` while project B starts at `More`.
- AE4. **Covered by R5.** Given an existing binding uses `Some`, when the project override later changes to `All`, then the existing binding remains `Some`.
- AE5. **Covered by R6.** Given project A has a `Less` override, when the operator selects `More`, then future `/new` sessions for project A start at `More` with no separate reset behavior.

### Scope Boundaries

**In scope**

- Optional project-level Working Updates persistence.
- Messaging `/new` precedence and persistence.
- Preserving the project override when a launchpad is materialized.
- Regression tests for project isolation, global fallback, binding creation, and launchpad reset.

**Out of scope**

- Adding another top-level Messaging setting; the existing setting already supplies the global fallback.
- Adding Working Updates to the desktop launchpad UI.
- Adding an inherit/reset choice.
- Changing the persisted binding key or `MessagingToolUpdateMode` values.
- Revisiting unrelated messaging elicitation or secret-answer behavior.

### Dependencies / Assumptions

- Directory launchpads are already persisted as JSON, so an optional field does not require a SQL migration.
- The messaging controller already obtains the selected project's launchpad before rendering the prompt gate.
- Existing binding preferences remain the source of truth once a thread is created.

### Sources / Research

- `apps/desktop/src/main/messaging/core/messaging-controller.ts` contains the `/new` picker, prompt-gate precedence, and binding materialization flow.
- `apps/desktop/src/main/app-server/backend-registry.ts` owns directory launchpad persistence and reset after materialization.
- `packages/shared/src/contracts/navigation.ts` and `packages/shared/src/contracts/agent.ts` define the launchpad and update contracts.
- `apps/desktop/src/renderer/src/features/settings/MessagingSettings.tsx` confirms the global Working Updates setting already exists.
- `docs/plans/2026-07-04-001-feat-messaging-working-updates-dial-plan.md` records the original intent that `/new` choices be sticky.

## Planning Contract

### Product Contract Preservation

The implementation preserves the Product Contract above without adding a new UI surface or reset semantic.

### Key Technical Decisions

- KTD1. Add an optional `messagingToolUpdateMode` field to the persisted `NavigationLaunchpadDraft` and the directory-launchpad update patch contract. Keep it out of `NavigationLaunchpadDefaults`: the existing Messaging config remains the global fallback, while this field represents only an explicit project override.
- KTD2. Resolve the `/new` mode in this order: current wizard session preference, selected project launchpad override, global Messaging default. This preserves immediate picker state while distinguishing explicit project choices from untouched projects.
- KTD3. When the Working Updates picker changes, update both the wizard session and the selected project's launchpad through the existing sticky-settings helper, but do not set the backend's broad `stickySettingsChanged` flag. That flag marks the whole launchpad as explicitly touched and would unintentionally freeze unrelated launchpad defaults; the explicit messaging field supplies its own persistence signal.
- KTD4. When materialization resets a directory launchpad, reseed the minimal launchpad row if it contains either a Codex environment selection or a project Working Updates override. Preserve the override without preserving prompt text or other one-shot launchpad state.
- KTD5. Continue copying the resolved session value into the created messaging binding. Do not consult project/global defaults for existing bindings after creation.

### Error Handling

- If no selected project is available, the existing sticky-settings helper remains a no-op and the wizard session still retains the chosen mode.
- If a persisted launchpad predates the optional field, absence is valid and resolution falls back to the global setting.
- Backend update failures follow the existing `/new` callback error path; no partial custom persistence path is introduced.

### Backward Compatibility

- Existing launchpad JSON without `messagingToolUpdateMode` remains valid.
- Existing bindings and the global `tool_update_mode` configuration are unchanged.
- No database schema or TOML migration is required.

## Implementation Units

### U1. Persist the Optional Project Override

**Goal:** Extend the shared launchpad contract and keep the project override across launchpad materialization.

**Requirements:** R1–R4, R6.

**Files:**

- `packages/shared/src/contracts/navigation.ts`
- `packages/shared/src/contracts/agent.ts`
- `apps/desktop/src/main/app-server/backend-registry.ts`
- `apps/desktop/src/main/__tests__/backend-registry.test.ts`

**Work:**

- Add the optional project override to the shared launchpad draft and update request.
- Preserve the field when resetting a materialized launchpad, alongside the existing environment-selection preservation behavior.
- Keep the field out of global launchpad-default propagation.

**Test scenarios:**

- A project launchpad can persist a concrete Working Updates override.
- Materializing and resetting the launchpad preserves the override but clears one-shot draft content.
- An absent override remains absent and does not acquire a copied global value.

### U2. Apply Project Precedence in Messaging `/new`

**Goal:** Make the picker write the project override and make future `/new` sessions read it.

**Requirements:** R1–R7.

**Dependencies:** U1.

**Files:**

- `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- `apps/desktop/src/main/__tests__/messaging-controller.test.ts`

**Work:**

- Resolve the Working Updates picker and prompt gate using session → project → global precedence.
- Persist explicit picker changes through `updateNewThreadStickySettings`.
- Verify created bindings still receive the effective mode and existing bindings remain isolated.

**Test scenarios:**

- An untouched project uses the live global default.
- A selected value is written to the project launchpad.
- A later `/new` for that project reuses the project override.
- A different untouched project still uses the global default.
- The created binding receives the effective value.

## Verification Contract

- Focused tests: `pnpm test apps/desktop/src/main/__tests__/backend-registry.test.ts apps/desktop/src/main/__tests__/messaging-controller.test.ts`
- Type safety: `pnpm typecheck`
- Correctness lint: `pnpm lint:eslint`
- Dependency architecture: `pnpm lint:boundaries`
- Patch hygiene: `git diff --check`

## Risks & Mitigations

- **Risk:** Launchpad reset deletes the new preference after the first thread is created. **Mitigation:** Cover the reset/materialization path directly in backend-registry tests.
- **Risk:** Treating the project value as a global launchpad default makes every project sticky unintentionally. **Mitigation:** Keep the field off `NavigationLaunchpadDefaults` and add an untouched-project fallback test.
- **Risk:** A session change updates the project but not the created binding. **Mitigation:** Retain the existing binding-preference assertion in the controller test.

## Definition of Done

- A concrete Working Updates choice in messaging `/new` persists for that project.
- The preference survives creating a thread and is reused by a later `/new` for the same project.
- Untouched projects follow the current global Messaging default.
- Existing bindings are unchanged by later default changes.
- Focused tests, typecheck, ESLint, dependency-boundary lint, and diff checks pass.
- Changes are committed on a signed feature branch, pushed, and submitted as a PR using the repository template.
