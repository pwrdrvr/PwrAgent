---
title: "feat: Add ACP Runtime Modes to Messaging"
type: feat
status: implemented
date: 2026-05-23
origin: docs/brainstorms/2026-05-17-acp-registry-backends-requirements.md
---

# feat: Add ACP Runtime Modes to Messaging

## Overview

Messaging can already create threads against ACP backends, and the desktop
thread UI can already drive ACP runtime modes such as Gemini `default`, `yolo`,
and edit-oriented modes. The missing feature is messaging parity: `/new` and
bound-thread status cards should expose the ACP agent's discovered runtime
modes through the same generic messaging action system used for providers,
models, workspace, streaming, and Codex permissions.

This is a Standard plan. The implementation should be small in concept, but it
touches security-relevant access posture, messaging callback state, and
backend-specific capability discovery.

## Problem Frame

The current messaging slice is conservative: ACP new-thread and status cards
show `Runtime mode: ... (desktop-only)` and hide the generic Codex permission
toggle unless an inherited Full Access default must be cleared. That prevents
messaging users from selecting the ACP runtime mode that the desktop launchpad
can already select.

This also creates a misleading model. `Full Access` is a Codex-facing
execution-mode label; ACP agents advertise provider-specific runtime modes and
config options. Messaging should not invent a Codex Full Access toggle for ACP,
but it should map discovered ACP runtime choices into a generic `Runtime mode`
action with the same warning/policy treatment for risky choices.

## Requirements Trace

- ACP backends must reflect capabilities honestly and hide unsupported features
  rather than papering over them (see origin:
  `docs/brainstorms/2026-05-17-acp-registry-backends-requirements.md`).
- ACP access modes must use PwrAgent's Default/Full Access model wherever ACP
  gives the client control over permission behavior, while preserving clear
  visibility into what is enforced by PwrAgent versus the ACP agent.
- Messaging `/new` must adapt provider-specific option buttons to the selected
  backend before the first prompt, including ACP/Gemini as another backend (see
  `docs/brainstorms/2026-05-22-messaging-new-thread-backend-selection-requirements.md`).
- Messaging Full Access policy remains authoritative: explicit escalation to a
  risky runtime mode must be warning-gated or blocked according to settings
  (see `docs/brainstorms/2026-05-22-messaging-full-access-approval-requirements.md`).
- Bound-thread mode changes must follow the same queue-at-turn-boundary
  semantics as desktop ACP runtime changes and Codex permission changes.

## Scope Boundaries

- Do not add ACP provider-specific branches for Gemini, Kimi, or any future
  agent. Use discovered `BackendAcpRuntimeCapabilities`.
- Do not expose a Codex `Full Access` toggle for ACP as the primary control.
  Messaging should show `Runtime mode`, with labels derived from ACP metadata.
- Do not invent runtime controls for ACP agents that advertise no modes and no
  mode-like config options.
- Do not change Codex permission-mode behavior.
- Do not broaden ACP discovery or install behavior in this work.
- Do not make model-only ACP config options appear as runtime modes.

## Context & Research

### Existing Patterns

- `apps/desktop/src/main/app-server/backend-registry.ts` already owns
  `setAcpSessionRuntimeOption`, queues ACP runtime changes while a turn is
  active, emits `thread/acpRuntime/updated`, and records permission-transition
  audit entries with labels derived from ACP metadata.
- `apps/desktop/src/main/app-server/acp-backend-adapter.ts` already exposes
  `acpRuntimeValueLooksPrivileged`, `formatAcpRuntimeLabel`, and
  `buildAcpLaunchpadOptions`. Today the launchpad helper only exports model
  choices; runtime mode choices remain available in ACP runtime capabilities.
- `apps/desktop/src/renderer/src/lib/useThreadNavigation.ts` already performs
  optimistic desktop updates before calling `setAcpSessionRuntimeOption`.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts` already stores
  `acpRuntime` in `MessagingBindingPreferences` and new-thread preferences, but
  it renders the runtime as desktop-only and provides no runtime picker.
- `apps/desktop/src/main/messaging/core/messaging-status-card.ts` already
  renders ACP runtime state and suppresses Codex permission controls for ACP.
- `packages/messaging/interface/src/index.ts` already includes
  `MessagingBindingPreferences.acpRuntime`, so the interface contract likely
  needs evolution rather than a brand-new persistence surface.

### Institutional Learnings

- `docs/solutions/2026-05-07-codex-permission-mode-state-machine.md` is the
  relevant permission precedent: never silently cross security-relevant routing
  boundaries, never trust implicit defaults, and queue mode changes at the
  turn boundary when the backend cannot apply them mid-turn.
- `docs/plans/2026-05-22-001-fix-messaging-full-access-approval-plan.md`
  established the inherited-versus-explicit Full Access distinction. ACP
  runtime mode changes should follow the same provenance principle: inherited
  defaults are not surprise escalations, explicit user selection of a risky ACP
  mode is.

### External Research

None used. The required behavior is a local mapping between existing PwrAgent
ACP capability data and existing PwrAgent messaging actions.

## Key Technical Decisions

- Add a provider-neutral ACP runtime mode descriptor helper in desktop main
  code. Messaging and status rendering should consume a normalized list of
  choices instead of guessing from string substrings in multiple places.
- Keep the helper pure and dependency-light. Do not make messaging import the
  full ACP backend adapter module just to reuse label/risk helpers; extract
  pure helpers to a shared/main utility if needed so ACP process/client code
  stays isolated.
- Treat ACP runtime modes as their own messaging action family:
  `Runtime mode: <label>`, not `Permissions: <label>`.
- Derive choices from, in priority order, advertised ACP modes and ACP config
  options whose category is `mode`. Keep the existing `endsWith("mode")`
  fallback only as a compatibility fallback for state display, not for
  constructing new selectable options when richer metadata exists.
- Use `acpRuntimeValueLooksPrivileged` as the first risk classifier. If an ACP
  choice is privileged, it should use the existing messaging Full Access
  warning/block policy before the selection is stored or applied.
- For new threads, store the selected ACP runtime in the pending browse session
  and pass it through `startThread`. For existing bound threads, call
  `setAcpSessionRuntimeOption` and let the backend registry decide
  apply-versus-queue.
- Show queued/applied runtime changes in the same audit/status language users
  already see for permission transitions, but with ACP labels such as
  `Default -> Yolo` rather than Codex-only `Default Access -> Full Access`.

## Open Questions

### Resolved During Planning

- Should messaging allow ACP escalation by using the Codex `Full Access`
  permission toggle?
  Resolution: no. The user-facing control should be `Runtime mode`, because
  ACP agents expose provider-specific modes. Risky selections still map into
  the existing Full Access policy gate.
- Should model config options be included in runtime mode choices?
  Resolution: no. Model selection stays the model action. Only ACP `modes` and
  `configOptions` with `category: "mode"` should become runtime mode choices.
- Should this require backend-registry protocol changes?
  Resolution: likely no. Existing `setAcpSessionRuntimeOption` and
  `acpRuntime` start-thread plumbing are sufficient unless implementation finds
  a missing bridge method in messaging's backend facade.

### Deferred to Implementation

- Exact callback IDs and pagination shape should follow existing
  `browse:new:*` and `status:*` picker conventions.
- If an ACP agent exposes both `modes.availableModes` and a `category: "mode"`
  config option, implementation should confirm which one `setRuntimeOption`
  expects for that specific discovered capability. Prefer advertised modes
  first, then config option modes.

## Implementation Units

- [x] **Unit 1: Centralize ACP Runtime Mode Choice Normalization**

**Goal:** Provide one main-process helper that turns ACP runtime capabilities and
session state into selectable messaging/runtime choices.

**Requirements:** ACP capability honesty, no model-as-mode regression,
provider-neutral labels.

**Files:**
- Modify or add: `apps/desktop/src/main/messaging/core/messaging-acp-runtime.ts`
- Modify: `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Modify: `apps/desktop/src/main/messaging/core/messaging-status-card.ts`
- Modify as needed: `apps/desktop/src/main/app-server/acp-backend-adapter.ts`
- Modify as needed: `packages/shared/src/contracts/backend.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-status-card.test.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-controller.test.ts`

**Approach:**
- Build a helper that accepts `BackendSummary`, current
  `BackendAcpSessionRuntimeState`, and launchpad/default runtime state.
- Return the current label plus a list of choices with `source`, `optionId`,
  `value`, `label`, `description`, `selected`, and `privileged`.
- Include `runtime.modes.availableModes` as `source: "mode"` choices.
- Include `runtime.configOptions` with `category: "mode"` as
  `source: "configOption"` choices.
- Exclude `category: "model"` and non-mode config options from runtime-mode
  pickers.
- Use `formatAcpRuntimeLabel` for fallback label formatting and
  `acpRuntimeValueLooksPrivileged` for initial risk classification.
- If those helpers remain in `acp-backend-adapter.ts`, extract their pure
  behavior before using them from messaging so importing runtime-mode UI logic
  does not pull in ACP stdio/client implementation details.

**Test scenarios:**
- Gemini-like capabilities with modes `default`, `auto_edit`, and `yolo`
  produce three runtime choices with `Yolo` marked privileged.
- Config option `{ id: "approval-mode", category: "mode" }` produces choices
  with `source: "configOption"` and `optionId: "approval-mode"`.
- Config option `{ id: "model", category: "model" }` does not produce runtime
  mode choices.
- Backend with no ACP runtime capabilities produces no choices and no action.
- Current runtime state selects the matching choice from `currentModeId` or the
  matching mode config option.

- [x] **Unit 2: Add ACP Runtime Mode Picker to Messaging New-Thread Flow**

**Goal:** Let messaging users choose an ACP runtime mode before the first prompt
when the selected provider advertises mode choices.

**Requirements:** Messaging backend option parity, launchpad default parity,
explicit-risk gating, no Codex label leakage.

**Files:**
- Modify: `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Modify if needed: `packages/messaging/interface/src/index.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-controller.test.ts`

**Approach:**
- Replace the `Runtime mode: ... (desktop-only)` line in the ready-to-start
  body with `Runtime mode: <label>` when choices exist.
- Add a `browse:new:runtime-mode` action when the selected backend is ACP and
  mode choices exist.
- Present a picker listing available runtime modes, respecting messaging
  capability profile action limits and using text fallback for constrained
  providers.
- On selection, if the target choice is privileged and the current effective
  runtime is not privileged, run the same Full Access warning/block policy used
  by explicit messaging escalation.
- Store approved selection in `session.preferences.acpRuntime` and
  `MessagingBindingPreferences.acpRuntime` as appropriate, without writing
  `executionMode: "full-access"` for ACP.
- Ensure `startThread` receives the selected `acpRuntime` so backend registry
  applies it before the session prompt.

**Test scenarios:**
- `/new` with Gemini selected shows `Runtime mode: Default` and a runtime-mode
  action, not `Runtime mode: ... (desktop-only)`.
- Selecting `Yolo` from the picker updates the ready card to
  `Runtime mode: Yolo` and passes `acpRuntime.currentModeId = "yolo"` to
  thread creation.
- Selecting privileged `Yolo` from `Default` is blocked when messaging Full
  Access escalation is disabled.
- Selecting privileged `Yolo` under a warning policy shows the existing warning
  flow and only stores the runtime after approval.
- Selecting non-privileged `Default` or equivalent applies without a warning.
- Changing provider away from ACP clears incompatible `acpRuntime` preferences.
- Changing from one ACP backend to another drops runtime selections that are
  not valid for the new backend.

- [x] **Unit 3: Add ACP Runtime Mode Actions to Bound Thread Status Cards**

**Goal:** Let messaging users change runtime mode on existing ACP threads using
the backend registry's existing apply-or-queue behavior.

**Requirements:** Existing-thread parity, queue semantics, status accuracy.

**Files:**
- Modify: `apps/desktop/src/main/messaging/core/messaging-status-card.ts`
- Modify: `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Modify: `apps/desktop/src/main/messaging/core/messaging-adapter.ts`
- Modify bridge wiring where the desktop registry is adapted into
  `MessagingBackendBridge`
- Test: `apps/desktop/src/main/__tests__/messaging-status-card.test.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-controller.test.ts`
- Test as needed: `apps/desktop/src/main/__tests__/backend-registry.test.ts`

**Approach:**
- Replace the current ACP status copy `Runtime mode: <label> (desktop-only)`
  with `Runtime mode: <label>`.
- Add a `status:runtime-mode` action for ACP bindings when choices exist.
- Add `setAcpSessionRuntimeOption` to `MessagingBackendBridge`, then wire it to
  the existing backend registry method rather than adding a messaging-specific
  ACP mutation path.
- Picker selections should call `backend.setAcpSessionRuntimeOption` with the
  normalized `source`, `optionId`, and `value`.
- Before applying a privileged target, reuse the Full Access warning/block
  policy. If the current or queued target is already privileged, changing among
  privileged ACP modes should still be explicit but should not be mislabeled as
  Codex Full Access.
- Optimistically update binding preferences only after warning approval. Then
  rely on `thread/acpRuntime/updated` or queue/audit refresh to render
  canonical state.
- If the thread is active, the registry should queue the mode change and the
  status card should show the queued transition from the permission-transition
  audit or an ACP runtime queue state if exposed.

**Test scenarios:**
- ACP status card renders a `Runtime mode: Yolo` action and no
  `Permissions: Full Access` action.
- Selecting `Default -> Yolo` on an idle thread calls
  `setAcpSessionRuntimeOption` with the correct ACP request.
- Selecting `Default -> Yolo` on an active thread results in queued transition
  copy and no claim that the change applied immediately.
- Selecting `Yolo -> Default` clears the privileged mode without requiring a
  warning.
- A backend with no runtime choices renders status text only and no runtime
  action.
- Existing Codex status-card permission tests continue to pass unchanged.

- [x] **Unit 4: Unify ACP Runtime Risk Copy and Audit Display**

**Goal:** Make warnings and transcript/status audit entries understandable for
provider-specific ACP modes.

**Requirements:** Clear security copy, no raw provider jargon unless it is the
mode label, queue/audit visibility.

**Files:**
- Modify: `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Modify: `apps/desktop/src/main/messaging/core/messaging-status-card.ts`
- Modify as needed: `apps/desktop/src/main/app-server/backend-registry.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-controller.test.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-status-card.test.ts`

**Approach:**
- Keep the policy concept as Full Access escalation internally, but tailor
  messaging copy to the ACP runtime target:
  `Yolo may allow the ACP agent to run commands or edit files with fewer
  prompts.`
- Continue using permission-transition records for audit, but use ACP labels
  in user-visible text.
- Avoid showing a generic `Full Access` chip/action when the selected backend is
  ACP unless the actual launchpad execution mode is still inherited
  Full Access and needs clearing.

**Test scenarios:**
- Privileged ACP warning mentions the selected runtime mode label.
- Warning cancel leaves the runtime at the previous mode.
- Warning approve updates/persists the selected ACP runtime.
- Audit/status text says `Default -> Yolo` or `Yolo -> Default`, not
  `Default Access -> Full Access`, for ACP runtime transitions.

- [x] **Unit 5: Add End-to-End Coverage for Messaging ACP Runtime Modes**

**Goal:** Lock the user-visible messaging path so ACP mode parity does not
regress again.

**Requirements:** Regression coverage across new-thread and existing-thread
messaging flows.

**Files:**
- Add or modify: `apps/desktop/e2e/*`
- Add or modify fixtures as needed under existing desktop E2E fixture paths
- Test support: `apps/desktop/src/main/__tests__/messaging-controller.test.ts`

**Approach:**
- Use the existing desktop replay/mock backend approach rather than launching a
  real ACP agent.
- Seed a fake ACP backend with discovered runtime capabilities for
  `default`, `auto_edit`, and `yolo`.
- Exercise at least one provider-neutral messaging flow through controller tests
  and one desktop E2E/replay path if the existing harness already covers
  messaging startup cards.

**Test scenarios:**
- New thread from messaging selects Gemini, chooses `Yolo`, approves warning,
  starts a thread, and the resulting thread summary shows ACP runtime `Yolo`.
- Bound ACP thread status changes from `Default` to `Yolo` while idle and the
  status card refreshes.
- Bound ACP thread changes from `Default` to `Yolo` while a turn is active and
  the queue/audit state is visible.

**Implementation note:** Messaging-specific ACP runtime flows are covered in
`messaging-controller.test.ts` and `messaging-status-card.test.ts`, where the
controller can drive provider callbacks without a real Telegram/Discord
adapter. The existing replay-backed desktop ACP runtime E2E spec was run as the
cross-surface regression for ACP runtime labels, mode updates, tool progress,
image replay ordering, replay noise, and handoff gating.

## Sequencing

1. Normalize ACP runtime choices first. This prevents duplicate string
   heuristics from spreading across new-thread and status-card flows.
2. Implement the new-thread picker next because it is creation-time state and
   already has `acpRuntime` preference plumbing.
3. Implement bound-thread status changes after new-thread storage is correct,
   reusing the same choice helper and risk gate.
4. Polish warning/audit copy once the behavior exists end to end.
5. Add E2E/replay coverage after unit tests define the state contract.

## Risks and Mitigations

- **Risk:** Messaging exposes a risky ACP mode without warning.
  **Mitigation:** Centralize `privileged` classification and route every
  explicit privileged selection through the existing Full Access controls.
- **Risk:** Model config options are mislabeled as runtime mode again.
  **Mitigation:** Build selectable runtime choices only from modes and
  `category: "mode"` config options; keep a regression test for model-only
  config.
- **Risk:** ACP agents use different names for equivalent privileged behavior.
  **Mitigation:** Start with existing classifier and make it centralized so new
  known privileged identifiers can be added in one place.
- **Risk:** Messaging providers with limited buttons overflow their action
  budgets.
  **Mitigation:** Use existing capability-profile prioritization and text
  fallback patterns.
- **Risk:** Mid-turn changes appear applied immediately.
  **Mitigation:** Route existing-thread changes only through
  `setAcpSessionRuntimeOption` and surface queued state from backend registry
  notifications/audit.

## Verification Plan

- Run focused unit tests:
  - `apps/desktop/src/main/__tests__/messaging-controller.test.ts`
  - `apps/desktop/src/main/__tests__/messaging-status-card.test.ts`
  - `apps/desktop/src/main/__tests__/backend-registry.test.ts`
- Run shared typecheck for contract changes.
- Run desktop E2E/replay coverage if Unit 5 adds or touches replay fixtures.
- Run existing ACP runtime replay E2E coverage as a cross-surface regression.
- Manually verify, using a dev profile with Gemini ACP enabled, that Telegram
  and desktop-created ACP threads show the same runtime mode labels and that
  choosing `Yolo` from messaging starts or resumes with the same behavior as
  the desktop control.

## Acceptance Criteria

- Messaging `/new` for ACP backends shows and can change ACP runtime mode before
  the first prompt.
- Messaging status cards for bound ACP threads show and can change ACP runtime
  mode when the backend advertises choices.
- Risky ACP runtime selections are blocked or warning-gated by the existing
  Full Access messaging settings.
- ACP runtime mode labels are provider-neutral and do not leak Codex
  `Default Access` / `Full Access` labels except where inherited execution mode
  genuinely matters.
- Model-only ACP config values are never displayed as runtime modes.
- Mid-turn ACP runtime changes queue and display honestly instead of claiming
  immediate application.
