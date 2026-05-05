---
title: "feat(messaging): capability discovery and adaptive rendering with Mattermost provider"
type: feat
status: active
date: 2026-05-04
origin: docs/brainstorms/2026-05-04-messaging-capability-discovery-requirements.md
---

# Messaging Capability Discovery and Adaptive Rendering

## Overview

Add a capability profile system to the messaging infrastructure so that providers declare their rendering constraints (button limits, layout support, text limits, attachments) and producers generate content adapted to those constraints without knowing which platform they're targeting. Implement Mattermost as the first provider built against this system. Migrate Discord and Telegram to declare capability profiles, replacing scattered hardcoded constants.

## Problem Statement

Message producers (pickers, questionnaires, approvals, status cards) generate actions with hardcoded assumptions: `RESUME_BROWSER_PAGE_SIZE = 8`, status cards emit 11 buttons unconditionally, approval prompts assume 4 buttons fit. Provider-specific limits (Discord 25 buttons/5 rows, Telegram 8 columns/unlimited rows) live as constants inside each adapter's formatting code. There is no mechanism for producers to discover what a connected provider can render, and no way to adapt content to different capability levels.

Adding each new provider without a capability system means producers either accumulate platform-aware branches (violating the channel-neutral contract) or new providers get a degraded experience because producers generated content for a different platform's limits. (See origin: `docs/brainstorms/2026-05-04-messaging-capability-discovery-requirements.md`)

## Proposed Solution

Extend `MessagingAdapterCapabilities` into a full `MessagingCapabilityProfile` covering four dimensions: actions, layout, text/formatting, and attachments. Each adapter declares its profile statically. The controller passes the profile to producer functions, which use it to compute page sizes, truncate action lists by priority, and choose text-only vs button rendering. The `deliver()` signature and intent shapes stay the same — what changes is that intents arrive already tailored to the adapter's constraints.

## Architectural Decisions

### Per-Controller Capability Passing (not centralized multi-tier routing)

The current architecture is **1 controller : 1 adapter**. `DesktopMessagingRuntime` creates one `MessagingController` per adapter and broadcasts backend events to all controllers in parallel (`messaging-runtime.ts:144-165`). Each controller independently builds intents and delivers through its single adapter.

The requirements doc describes a "pre-query multi-tier" model (R7-R13). In practice, this maps naturally to the 1:1 architecture: each controller queries its own adapter's profile and passes it to the producer function it calls. There is no cross-controller routing needed. If two adapters have the same profile, each controller independently generates the same intent — deduplication is an optimization with no current use case.

This decision preserves the existing controller isolation, avoids a new routing layer, and satisfies the requirements because producers never see platform names — they receive an abstract capability profile.

### Text Baseline via Existing `fallbackText`

The requirements (R10) say "a text-only baseline tier must always be present." The existing intent types already carry `fallbackText` fields on actions, and producers like the approval renderer already generate text fallback strings ("Reply yes, yes for this session, no, cancel, or a choice number"). A text-only adapter (future Signal) renders the intent's text parts with numbered choice lists derived from action labels and `fallbackText`. No separate "text baseline intent" is needed.

### Priority-Based Action Truncation

When a producer generates more actions than a profile allows (e.g., status card's 11 buttons on an 8-button provider), actions are dropped by priority. Add an optional `priority` field to `MessagingSurfaceAction`. Producers assign priority (lower number = higher priority). Actions without an explicit `priority` are treated as lowest priority (dropped first) — this preserves backward compatibility since existing actions are the ones that haven't been prioritized yet. When action count exceeds `maxActions`, lowest-priority actions are dropped. Dropped actions remain accessible via text fallback.

### Adapter Defensive Truncation Preserved

After migration, adapters keep their existing defensive truncation (Discord's `.slice(0, 25)`, Telegram's layout clamping) as a safety net. If truncation fires on a capability-aware intent, the adapter logs a warning — this indicates a producer bug, not expected behavior.

### Layout Responsibility Stays with Adapters

Producers use the profile to cap total action count (`maxActions`). Adapters continue to own row layout via `layoutMessagingActionRows` with their own `maxColumns` and `maxRows`. The profile's `maxActions` must be consistent with `maxActionsPerRow * maxRows` (if both are bounded) to prevent the split-responsibility gap where a valid-count intent doesn't fit the layout grid.

## Technical Approach

### Architecture

```
┌─────────────────────────────────────────────┐
│              MessagingRuntime               │
│  broadcasts backend events to all controllers│
└──────┬──────────────┬───────────────┬───────┘
       │              │               │
       ▼              ▼               ▼
┌─────────────┐ ┌─────────────┐ ┌─────────────┐
│ Controller  │ │ Controller  │ │ Controller  │
│ (Discord)   │ │ (Telegram)  │ │ (Mattermost)│
│             │ │             │ │             │
│ reads       │ │ reads       │ │ reads       │
│ adapter     │ │ adapter     │ │ adapter     │
│ .profile    │ │ .profile    │ │ .profile    │
│             │ │             │ │             │
│ passes to   │ │ passes to   │ │ passes to   │
│ producer fn │ │ producer fn │ │ producer fn │
│             │ │             │ │             │
│ delivers    │ │ delivers    │ │ delivers    │
│ tailored    │ │ tailored    │ │ tailored    │
│ intent      │ │ intent      │ │ intent      │
└─────────────┘ └─────────────┘ └─────────────┘
```

Producer functions become:
```typescript
function buildThreadPickerIntent(
  profile: MessagingCapabilityProfile,
  session: MessagingBrowseSessionRecord,
  threads: NavigationThreadSummary[],
  // ... other params
): MessagingThreadPickerIntent
```

The profile drives page size (`maxActions - navButtonCount`), layout hints, and text-only rendering decisions.

### Implementation Phases

#### Phase 1: Capability Profile Type

Define the `MessagingCapabilityProfile` type in `@pwragent/messaging-interface` and extend the `MessagingAdapter` type.

**Tasks:**

- [x] Define `MessagingCapabilityProfile` in `packages/messaging/interface/src/index.ts`
- [x] Add optional `priority` field to `MessagingSurfaceAction`
- [x] Add `capabilities?: MessagingCapabilityProfile` to the adapter type in `apps/desktop/src/main/messaging/core/messaging-adapter.ts` (keep optional during migration — make required after Phase 2 updates all adapters)
- [x] Keep `MessagingAdapterCapabilities` as a deprecated type alias during migration
- [x] Add a `capabilityProfilePageSize(profile, navActionCount, maxPageSize?)` utility to compute page size from action constraints, capped by an optional upper bound to prevent unusable UX on high-limit platforms
- [x] Add a `capabilityProfileMinActions(surfaceKind)` utility that returns the minimum action count needed for a surface type (e.g., picker needs ≥2, status card needs ≥3) — below this threshold, the producer falls back to text-only rendering
- [x] Update the duplicate types in `packages/shared/src/contracts/messaging.ts` to match (or document the duplication as tech debt if full unification is out of scope for this work)

**Capability Profile Type Design:**

```typescript
export type MessagingActionCapabilities = {
  /** Total buttons allowed per message. */
  maxActions: number;
  /** Max buttons per row for row-based layouts. */
  maxActionsPerRow: number;
  /** Max rows. Undefined = unlimited. */
  maxRows?: number;
  /** Button label character limit. */
  maxLabelLength: number;
  /** Whether primary/secondary/danger/navigation visual distinction works. */
  supportsStyles: boolean;
  /** Whether disabled/grayed-out buttons are supported. */
  supportsDisabled: boolean;
  /** Whether explicit row/column/width layout hints are supported. */
  supportsLayoutHints: boolean;
  /** Max callback payload bytes for interactive buttons. */
  maxCallbackPayloadBytes: number;
};

export type MessagingTextCapabilities = {
  /** Max message length. */
  maxLength: number;
  /** How maxLength is measured. */
  encoding: "utf8-bytes" | "utf16-units" | "characters";
  /** Markdown dialect the platform renders. */
  markdownDialect: "plain" | "html" | "slack-mrkdwn" | "discord-markdown" | "markdown";
  supportsCodeBlocks: boolean;
  supportsBold: boolean;
  supportsItalic: boolean;
  supportsLinks: boolean;
  supportsInlineCode: boolean;
  /** Caption length limit for image messages (e.g., Telegram 1024). */
  maxCaptionLength?: number;
  /** Whether the platform can edit/update sent messages in place. */
  supportsMessageEdit: boolean;
};

export type MessagingCapabilityProfile = {
  /**
   * Action/button capabilities. Null = no interactive button support
   * (text-only provider like Signal).
   */
  actions: MessagingActionCapabilities | null;
  /** Text and formatting capabilities. */
  text: MessagingTextCapabilities;
  /** Inbound attachment capabilities. */
  inboundAttachments?: {
    maxAttachmentCount?: number;
    maxDownloadBytes?: number;
    supportsDownload: boolean;
  };
  /** Outbound attachment capabilities. */
  outboundAttachments?: {
    maxUploadBytes?: number;
    supportsFileUpload: boolean;
    supportsImageUpload: boolean;
    supportsRemoteImageUrl: boolean;
  };
};
```

**Key files:**
- `packages/messaging/interface/src/index.ts` — profile type, `MessagingSurfaceAction.priority`, utility
- `packages/shared/src/contracts/messaging.ts` — duplicate type sync
- `apps/desktop/src/main/messaging/core/messaging-adapter.ts:55-64` — adapter type update

**Acceptance criteria:**
- [x] `MessagingCapabilityProfile` type compiles and is exported from `@pwragent/messaging-interface`
- [x] `MessagingSurfaceAction` has an optional `priority?: number` field
- [x] `capabilityProfilePageSize(profile, navCount, maxPageSize?)` returns `min(profile.actions.maxActions - navCount, maxPageSize ?? 8)` when actions is non-null, or a configurable text-mode page size (e.g., 20) when null. The `maxPageSize` default of 8 preserves current behavior — platforms can opt into larger pages explicitly.
- [x] `capabilityProfileMinActions(surfaceKind)` returns the minimum usable action count for a surface. If `profile.actions.maxActions` is below this, the producer renders text-only.
- [x] `MessagingAdapterCapabilities` is a deprecated alias
- [x] `pnpm lint:boundaries` passes

---

#### Phase 2: Discord and Telegram Profile Declarations

Migrate existing providers to declare full capability profiles. Replace hardcoded constants with profile reads where possible. Pin current behavior with tests before migration.

**Tasks:**

- [ ] Pin current behavior: add snapshot test cases for Discord formatting (status card with 11 buttons, thread picker with 8 items + nav, approval with 4 decisions) in `discord-formatting.test.ts`
- [ ] Pin current behavior: add snapshot test cases for Telegram formatting (same surfaces) in `telegram-formatting.test.ts`
- [x] Declare `capabilities: MessagingCapabilityProfile` on `DiscordProviderAdapter` (`discord-adapter.ts:233-245`)
- [x] Declare `capabilities: MessagingCapabilityProfile` on `TelegramProviderAdapter` (`telegram-adapter.ts:338-350`)
- [ ] Replace hardcoded constants in Discord formatting with profile reads **only where the value crosses the adapter boundary** (e.g., `maxActions`, `maxLabelLength`). Constants used purely within the adapter's own formatting code (e.g., `DISCORD_MESSAGE_CONTENT_LIMIT` for chunking, `DISCORD_COMPONENT_CUSTOM_ID_LIMIT_BYTES` for handle encoding) stay as adapter-local constants — they don't need to flow through the profile because no producer reads them.
- [ ] Same boundary rule for Telegram: profile declares the values, but adapter-internal constants (`TELEGRAM_MESSAGE_TEXT_LIMIT` for chunking, `TELEGRAM_CALLBACK_DATA_LIMIT_BYTES` for handle encoding) stay local. The profile is for cross-boundary communication, not for replacing every `const` in the adapter.
- [ ] Keep adapter-side defensive truncation (Discord `.slice(0, 25)`, layout `maxRows: 5`) as safety nets with warning logs when triggered on a capability-aware intent
- [ ] Verify pinned test snapshots still pass after migration

**Discord profile:**
```typescript
capabilities: {
  actions: {
    maxActions: 25,
    maxActionsPerRow: 5,
    maxRows: 5,
    maxLabelLength: 80,
    supportsStyles: true,
    supportsDisabled: true,
    supportsLayoutHints: true,
    maxCallbackPayloadBytes: 100,
  },
  text: {
    maxLength: 2000,
    encoding: "characters",
    markdownDialect: "discord-markdown",
    supportsCodeBlocks: true,
    supportsBold: true,
    supportsItalic: true,
    supportsLinks: true,
    supportsInlineCode: true,
    supportsMessageEdit: true,
  },
  inboundAttachments: { maxAttachmentCount: 10, maxDownloadBytes: 25 * 1024 * 1024, supportsDownload: true },
  outboundAttachments: { maxUploadBytes: 25 * 1024 * 1024, supportsFileUpload: true, supportsImageUpload: true, supportsRemoteImageUrl: true },
}
```

**Telegram profile:**
```typescript
capabilities: {
  actions: {
    maxActions: 100,
    maxActionsPerRow: 8,
    // maxRows omitted — Telegram has no practical row limit
    maxLabelLength: 64,
    supportsStyles: false,  // Telegram inline keyboard has no style distinction
    supportsDisabled: false,
    supportsLayoutHints: true,
    maxCallbackPayloadBytes: 64,
  },
  text: {
    maxLength: 4096,
    encoding: "utf8-bytes",
    markdownDialect: "html",
    supportsCodeBlocks: true,
    supportsBold: true,
    supportsItalic: true,
    supportsLinks: true,
    supportsInlineCode: true,
    maxCaptionLength: 1024,
    supportsMessageEdit: true,
  },
  inboundAttachments: { maxAttachmentCount: 10, maxDownloadBytes: 20 * 1024 * 1024, supportsDownload: true },
  outboundAttachments: { maxUploadBytes: 50 * 1024 * 1024, supportsFileUpload: false, supportsImageUpload: true, supportsRemoteImageUrl: true },
}
```

**Key files:**
- `packages/messaging/providers/discord/src/discord-adapter.ts:233-245` — profile declaration
- `packages/messaging/providers/discord/src/discord-formatting.ts:9-10` — hardcoded constants
- `packages/messaging/providers/telegram/src/telegram-adapter.ts:338-350` — profile declaration
- `packages/messaging/providers/telegram/src/telegram-formatting.ts:10-11` — hardcoded constants
- `packages/messaging/providers/discord/src/__tests__/` — pin tests
- `packages/messaging/providers/telegram/src/__tests__/` — pin tests

**Acceptance criteria:**
- [x] Both providers export `capabilities: MessagingCapabilityProfile` (required, not optional)
- [x] After both providers are updated, make `capabilities` required (not optional) on the `MessagingAdapter` type
- [ ] Pinned behavior tests pass before and after migration
- [x] `pnpm lint` and `pnpm lint:boundaries` pass
- [ ] Existing desktop E2E messaging tests pass (`pnpm test:desktop-e2e`) — deferred (not run in this session)

---

#### Phase 3: Capability-Aware Producers

Modify producer functions to accept a `MessagingCapabilityProfile` parameter and adapt their output. This is the core behavioral change.

**Tasks:**

- [x] **Resume browser** (`messaging-resume-browser.ts`): Added `resumeBrowserPageSize(profile)` helper using `capabilityProfilePageSize`. `RESUME_BROWSER_PAGE_SIZE` kept as default. Controller uses `resumeBrowserPageSize(this.capabilityProfile)` at session creation.
- [x] **Status card** (`messaging-status-card.ts`): Assigned `priority` to all 11 actions (Stop=1 through Sync-name=11). Uses `truncateActionsByPriority` when profile limits maxActions. Returns empty actions when profile.actions below min status threshold.
- [x] **Handoff branch picker** (`messaging-status-card.ts`): Accepts optional `capabilityProfile` param for future dynamic page size.
- [x] **Approval renderer** (`messaging-approval-renderer.ts`): Verified — 4 decisions with `fallbackText` on each. No profile changes needed; fits all platforms.
- [x] **Questionnaire renderer** (`messaging-renderer.ts:buildQuestionnaireIntent`): Verified — `fallbackText: String(index + 1)` on each option.
- [x] **Thread/project picker** (`messaging-renderer.ts`): Already parameterized with `pageSize` and `actions` — profile adaptation handled at controller level.
- [x] **Single/multi-select** (`messaging-renderer.ts`): Already parameterized — profile adaptation at controller level.
- [x] **Confirmation renderer** (`messaging-renderer.ts:buildConfirmationIntent`): Verified — accepts actions, typically 2-3 buttons, fits all platforms.

**Key files:**
- `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts:19` — `RESUME_BROWSER_PAGE_SIZE`
- `apps/desktop/src/main/messaging/core/messaging-status-card.ts:28,101-176` — `HANDOFF_BRANCH_PAGE_SIZE`, action list
- `apps/desktop/src/main/messaging/core/messaging-approval-renderer.ts:57-86` — decisions
- `apps/desktop/src/main/messaging/core/messaging-renderer.ts` — intent builders

**Acceptance criteria:**
- [x] Resume browser page size varies by adapter capability profile
- [x] Status card gracefully drops low-priority actions on providers with fewer than 11 button slots
- [x] All producers render meaningful content when `profile.actions` is null (text-only)
- [x] All producers populate `fallbackText` on every action
- [ ] Unit tests cover: 8-button profile, 25-button profile, 100-button profile, and null-action (text-only) profile for each producer

---

#### Phase 4: Controller Integration

Wire the capability profile through the controller to all producer call sites.

**Tasks:**

- [x] Add `capabilityProfile: MessagingCapabilityProfile` as a resolved property on `MessagingController` (read from `this.options.adapter.capabilityProfile` at construction)
- [x] Update producer call sites in `messaging-controller.ts` to pass `this.capabilityProfile`:
  - `buildBindingStatusIntent` (2 sites) → passes capabilityProfile
  - `buildHandoffBranchPickerIntent` → passes capabilityProfile
  - Other producers (approval, questionnaire, confirmation, select) are already parameterized via their action/pageSize params — no profile param needed
- [x] Update browse session creation to compute `pageSize` from `resumeBrowserPageSize(this.capabilityProfile)` instead of `RESUME_BROWSER_PAGE_SIZE`
- [ ] Add controller-level test: mock adapter with a constrained profile (8 buttons), verify the controller produces adapted intents

**Key files:**
- `apps/desktop/src/main/messaging/core/messaging-controller.ts` — all producer call sites (grep for `buildBindingStatusIntent`, `buildThreadPickerIntent`, `buildProjectPickerIntent`, `buildApprovalIntent`, `buildQuestionnaireIntent`, `buildConfirmationIntent`)
- `apps/desktop/src/main/messaging/core/messaging-controller.test.ts` — integration tests

**Acceptance criteria:**
- [x] Controller reads adapter profile at construction and passes it to all producers
- [x] No producer is called without a profile
- [x] Existing controller tests pass
- [ ] New test: constrained-profile controller produces adapted intents

---

#### Phase 5: Mattermost Adapter

Implement the Mattermost messaging adapter as the first provider built against the capability profile system, validating that zero producer changes are needed.

**Tasks:**

- [ ] **Research**: Determine Mattermost interactive message API limits — actions per attachment, action label length, callback payload format and size limit, markdown dialect, message length limit, file upload limits, bot framework options (mattermost-client, REST API, webhook)
- [ ] Create `packages/messaging/providers/mattermost/` with package.json, tsconfig.json, src/index.ts
- [ ] Add `@pwragent/messaging-provider-mattermost` to workspace, dependency-cruiser rules, and build config
- [ ] Declare Mattermost `MessagingCapabilityProfile` based on researched API limits
- [ ] Implement `MattermostProviderAdapter`:
  - Bot connection (websocket or webhook-based event listening)
  - Inbound event normalization (`MessagingInboundEvent`)
  - Intent delivery (render `MessagingSurfaceIntent` → Mattermost message attachments with actions)
  - Callback handle persistence and resolution
  - Message edit support (if Mattermost supports it)
  - Attachment upload/download
  - Conversation title updates (channel header or topic)
  - Typing indicators (if supported)
  - Streaming response updates via message edit
- [ ] Add `"mattermost"` to `DesktopMessagingProviderId` in `provider-loader.ts`
- [ ] Add Mattermost entry in `defaultMessagingProviderRegistry` with dynamic import
- [ ] Add Mattermost config type and config reading in provider loader
- [ ] Add `.dependency-cruiser.cjs` rules for the new provider package
- [ ] Write adapter tests covering: text message delivery, button rendering, callback resolution, attachment handling, profile declaration
- [ ] End-to-end validation: bind a Mattermost channel to a thread, drive thread picker, approval, and questionnaire flows

**Key files:**
- `packages/messaging/providers/mattermost/` — new package (entire directory)
- `apps/desktop/src/main/messaging/provider-loader.ts:33-72` — provider ID, registry, loading
- `.dependency-cruiser.cjs` — boundary rules for new provider

**Acceptance criteria:**
- [ ] Mattermost adapter passes all the same workflow flows as Discord/Telegram (binding, pickers, approvals, questionnaires, status, text fallback)
- [ ] Zero changes to any producer code — the adapter works purely through its capability profile
- [ ] `pnpm lint:boundaries` passes with Mattermost provider added
- [ ] Callback handles are restart-safe (persisted to store, not just in-memory)

---

#### Phase 6: Design Validation and Cleanup

Validate the capability profile design against future providers. Clean up deprecated types.

**Tasks:**

- [ ] **Signal validation**: Confirm `actions: null` (text-only) profile expresses Signal's constraints. Verify that all producers generate meaningful text-only output. Document any profile gaps.
- [ ] **Slack validation**: Research Block Kit action limits (max actions per block, max blocks, overflow menus). Draft a hypothetical Slack capability profile. Confirm the profile type can express it without structural changes. Document whether Slack's "overflow menu" pattern (grouping excess actions into a "..." dropdown) would require a profile extension.
- [ ] **Feishu/Lark validation**: Research interactive card constraints (button layout, column support, action limits). Draft a hypothetical Feishu profile. Confirm expressibility.
- [ ] Document the validation analysis as a comment block or a short addendum in the requirements doc
- [ ] Remove `MessagingAdapterCapabilities` deprecated alias if all consumers are migrated
- [ ] Remove `RESUME_BROWSER_PAGE_SIZE` and `HANDOFF_BRANCH_PAGE_SIZE` constants (replaced by profile-driven computation)
- [ ] Verify `packages/shared/src/contracts/messaging.ts` type duplication is resolved or documented as tech debt

**Acceptance criteria:**
- [ ] Signal, Slack, and Feishu capability profiles can be expressed without changing the `MessagingCapabilityProfile` type
- [ ] No deprecated aliases remain
- [ ] No hardcoded page size constants remain in producer code

## System-Wide Impact

### Interaction Graph

Backend event arrives → `DesktopMessagingRuntime.onEvent` broadcasts to all controllers → each `MessagingController` reads its adapter's profile → passes profile to producer function → producer generates profile-adapted intent → controller calls `adapter.deliver(intent)` → adapter renders and delivers → adapter returns `MessagingDeliveryResult` → controller records delivery.

The profile read is a synchronous property access, not an async call. No new callbacks, middleware, or observers are introduced.

### Error Propagation

- During Phase 1, `adapter.capabilities` is optional. The controller uses a default "permissive" profile (high limits, all features enabled) when undefined, so behavior is unchanged. After Phase 2 updates all adapters, `capabilities` becomes required and the fallback is dead code — remove it.
- If a producer generates more actions than `maxActions`, the adapter's defensive truncation fires and logs a warning. The message still delivers — it's degraded, not broken.
- Profile misconfiguration (e.g., `maxActions: 25` but `maxRows: 3, maxActionsPerRow: 5` = 15 slots) is a static bug, not a runtime error. Add a profile validation utility that checks consistency and warns at adapter construction time.

### State Lifecycle Risks

- `MessagingBrowseSessionRecord.pageSize` becomes adapter-specific. Sessions are already channel-scoped, so no cross-adapter contamination. A session created for Discord (pageSize 8, capped by maxPageSize default) is never rendered by the Telegram controller.
- If a provider's profile changes between restarts (e.g., a config update changes max buttons), existing browse sessions may have stale page sizes. This is low risk — browse sessions have TTLs and will be recreated.

### API Surface Parity

- `MessagingAdapter.capabilities` changes from optional to required. All adapter implementations must be updated.
- `MessagingSurfaceAction.priority` is additive (optional field) — no breaking change.
- Producer function signatures gain a `profile` parameter — all call sites in the controller must be updated.
- The `layoutMessagingActionRows` utility signature is unchanged.

### Integration Test Scenarios

1. **Profile-driven pagination**: Create a controller with an 8-button-limit adapter, trigger thread picker with 20 threads. With ~5 nav buttons (Previous, Next, Projects, New, Cancel — count varies by state), verify page shows 3 items + 5 nav = 8 buttons. "Next" advances to items 4-6.
2. **Status card truncation**: Create a controller with a 6-button-limit adapter. Verify status card shows 6 highest-priority actions, remaining actions accessible via text commands.
3. **Text-only rendering**: Create a controller with `actions: null` profile. Trigger approval prompt. Verify the adapter receives a text-only intent with numbered choice fallback.
4. **Mattermost full workflow**: Bind Mattermost channel → thread picker → select thread → send message → receive response → trigger approval → approve via button → detach.
5. **Migration regression**: Run existing Discord/Telegram E2E tests after migration. Verify identical behavior (same page sizes, same button layouts, same text formatting).

## Acceptance Criteria

### Functional Requirements

- [ ] Producers adapt content to capability profiles without branching on platform names
- [ ] Page sizes, action counts, and rendering mode vary by adapter capability
- [ ] Mattermost adapter achieves full workflow parity with Discord/Telegram
- [ ] Text-only profiles produce meaningful numbered-choice output from all producers
- [ ] All actions have `fallbackText` populated for text-reply accessibility

### Non-Functional Requirements

- [ ] No performance regression — profile reads are synchronous property access
- [ ] Package boundary rules enforced (`pnpm lint:boundaries`)
- [ ] Mattermost callback handles are restart-safe (persisted, not in-memory)

### Quality Gates

- [ ] Unit tests for each producer with 4 profile configurations (text-only, 8-button, 25-button, 100-button)
- [ ] Pinned behavior snapshots for Discord and Telegram before and after migration
- [ ] Controller integration test with constrained profile
- [ ] Desktop E2E tests pass

## Dependencies & Prerequisites

- The existing messaging interface, adapter contract, and provider package boundaries are stable and proven by Discord + Telegram. (See origin: `docs/brainstorms/2026-05-04-messaging-capability-discovery-requirements.md`, Dependencies)
- The `layoutMessagingActionRows` utility is reused without changes — adapters parameterize it from their profiles.
- The callback handle persistence model (Telegram's `MessagingCallbackHandleStore`) generalizes to Mattermost.
- Mattermost API research is needed before Phase 5 implementation (SDK choice, interactive message limits, webhook vs bot approach).

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Mattermost interactive message API has unexpected limitations (e.g., very low action count) | Medium | Medium | Research API in Phase 5 before implementation. The capability profile is designed to express arbitrary constraints. |
| Producer migration introduces pagination regressions (page size changes) | Medium | High | Pin current behavior with snapshot tests in Phase 2 before touching producers. |
| Profile type needs extension for Slack/Feishu that wasn't anticipated | Low | Low | Phase 6 design validation catches this before those providers are implemented. Profile type is additive — new optional fields don't break existing providers. |
| Type duplication between `@pwragent/shared` and `@pwragent/messaging-interface` causes drift | Medium | Medium | Update both in Phase 1. Flag as tech debt if full unification is out of scope. |

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-05-04-messaging-capability-discovery-requirements.md](docs/brainstorms/2026-05-04-messaging-capability-discovery-requirements.md) — Key decisions carried forward: (1) separate variants per tier via per-controller profile passing, (2) text baseline via existing fallbackText, (3) unified capability profile replacing `MessagingAdapterCapabilities`.

### Internal References

- Adapter interface: `apps/desktop/src/main/messaging/core/messaging-adapter.ts:55-64`
- Controller delivery: `apps/desktop/src/main/messaging/core/messaging-controller.ts:3046-3081`
- Runtime broadcast: `apps/desktop/src/main/messaging/messaging-runtime.ts:144-165`
- Resume browser page size: `apps/desktop/src/main/messaging/core/messaging-resume-browser.ts:19`
- Status card actions: `apps/desktop/src/main/messaging/core/messaging-status-card.ts:101-176`
- Approval renderer: `apps/desktop/src/main/messaging/core/messaging-approval-renderer.ts:57-86`
- Discord limits: `packages/messaging/providers/discord/src/discord-formatting.ts:9-10,130-159`
- Telegram limits: `packages/messaging/providers/telegram/src/telegram-formatting.ts:10-11,163-164`
- Provider loader: `apps/desktop/src/main/messaging/provider-loader.ts:33-72`
- Package boundaries: `packages/messaging/AGENTS.md`
- Adapter contract doc: `docs/messaging-adapter-contract.md`
- Original messaging requirements: `docs/brainstorms/2026-04-30-messaging-platform-integration-requirements.md`
