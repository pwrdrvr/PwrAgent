---
title: fix: Harden messaging tool update batching
type: fix
status: active
date: 2026-05-02
origin: docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md
---

# fix: Harden messaging tool update batching

## Overview

Tighten the messaging tool-update feature after live Telegram testing showed
that Codex behaves close to the intended `Show Some` experience, while Grok can
produce noisy and low-value updates. The concrete fix is not to redesign the
feature; it is to close two implementation gaps:

- queued tool batches can flush for every active turn on a binding instead of
  the turn whose message/status is being delivered
- Grok `dynamicToolCall` summaries lose useful path/query details and collapse
  into generic titles such as `read file`

## Problem Frame

The completed verbosity plan intentionally batches by binding and turn. That is
correct for ordinary Codex turns, where one active messaging turn owns the tool
activity stream. Live Grok testing exposed a different shape: two overlapping
turns for the same bound conversation emitted tool completions in the same
minute. Because the controller's generic `deliver()` flush path only knows the
binding, it can flush pending batches for every turn attached to that binding.
That makes multiple batch messages appear close together and makes the mode
feel broken even though the single-turn policy tests pass.

The same Grok run also showed weak labels. Grok emits `dynamicToolCall` items
with tool names and arguments such as paths or queries, but the messaging
summarizer currently falls back to generic tool names instead of producing
Codex-quality labels.

## Requirements Trace

- R1. `Show Some` should remain useful for normal Codex-style single active
  turns: first three quiet updates can be individual, then noisy work batches.
- R2. Overlapping backend turns for the same binding must not cause unrelated
  turn batches to flush early.
- R3. Generated tool-update messages must preserve temporal order relative to
  assistant messages, approvals, questionnaires, and status updates for the
  relevant turn.
- R4. Grok dynamic tool summaries should include safe path/query context when
  available, matching the usefulness of Codex `commandActions`.
- R5. The fix must stay channel-neutral; Telegram and Discord adapters should
  continue rendering generic message intents.

## Scope Boundaries

- In scope: controller flush scoping, overlapping-turn regression coverage,
  Grok `dynamicToolCall` title extraction, and targeted documentation notes if
  behavior changes.
- Out of scope: changing the five verbosity modes, changing Telegram/Discord
  rendering behavior, changing app-server protocols, and redesigning Grok's
  tool execution model.
- Out of scope: making every Grok tool label perfect. This pass should cover
  the concrete observed tool shapes: read file, list files, search code, and
  safe command-like dynamic tools.

## Context & Research

### Relevant Code and Patterns

- `apps/desktop/src/main/messaging/core/messaging-tool-update-policy.ts`
  already stores policy state by `bindingId`, `turnId`, and mode.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts` calls
  `flushToolUpdatesForBinding()` before delivering most user-visible intents.
  The current generic path lacks a `turnId`, so it flushes every pending turn for
  the binding.
- `apps/desktop/src/main/messaging/core/messaging-tool-activity.ts` owns safe
  tool title generation and already strips shell wrappers, redacts secrets, and
  handles Codex `commandActions`.
- `apps/desktop/src/main/__tests__/messaging-controller.test.ts` already covers
  individual delivery, batching before assistant/status messages, and
  suppression.
- `apps/desktop/src/main/__tests__/messaging-tool-activity.test.ts` already
  covers safe shell command titles, file-change summaries, unknown item
  suppression, and secret redaction.

### Institutional Learnings

- `docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md`
  explicitly chose turn-scoped batching and flushing before later user-visible
  responses.
- `docs/messaging-platform-integration.md` documents the intended default:
  `Show Some` sends a few individual updates and batches noisy activity.

### External References

- External research is not needed. This is an internal controller-state and
  event-normalization fix grounded in captured PwrAgnt behavior.

## Key Technical Decisions

- **Keep policy state turn-scoped.** The policy already has the right state key;
  the controller should preserve that boundary when flushing.
- **Flush by explicit turn whenever the triggering event has one.** Backend
  events and pending requests carry turn ids. Those paths should flush only that
  turn's queued tools before delivering assistant text, approval prompts,
  questionnaires, terminal status, or other turn-specific output.
- **Keep binding-wide flushes only for binding-wide lifecycle actions.** Detach,
  dispose, and cleanup paths may intentionally clear all pending batches for a
  binding because the binding itself is going away or becoming stale.
- **Improve Grok labels in the summarizer, not in providers.** Telegram and
  Discord should continue to render the same generic system message intents.
- **Prefer safe basename/query summaries over raw argument dumps.** Path and
  query context is useful; raw dynamic tool arguments may contain bulky data or
  sensitive strings and should not be blindly serialized.

## Open Questions

### Resolved During Planning

- **Is there concrete work here?** Yes. The live Grok run exposed a real
  controller integration bug for overlapping turns, plus a bounded summarizer
  gap for Grok dynamic tools.
- **Should the fix change the global `Show Some` thresholds?** No. Codex testing
  shows the current thresholds are close to the intended experience.
- **Should batching become binding-wide instead of turn-scoped?** No. That would
  make independent turns influence each other's noise budget and would weaken
  the temporal-ordering guarantee.

### Deferred to Implementation

- Exact extraction rules for every Grok dynamic tool name are deferred until
  implementation inspects the observed item shapes already present in fixtures
  or protocol captures.
- Whether to add a replay fixture for this exact Grok capture is deferred; unit
  coverage may be enough if it faithfully models overlapping turns and dynamic
  tool arguments.

## Implementation Units

- [ ] **Unit 1: Scope tool-update flushes to the triggering turn**

**Goal:** Prevent status or assistant delivery for one active turn from flushing
queued tool batches for another turn on the same binding.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-controller.test.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-tool-update-policy.test.ts`

**Approach:**
- Identify controller delivery paths that are triggered from backend events and
  carry a known turn id.
- Pass that turn id into the tool-update flush helper before delivering
  assistant text, approval/questionnaire prompts, terminal status, and status
  refreshes caused by that same event.
- Keep binding-wide flush behavior only where the binding lifecycle is being
  retired, detached, disposed, or otherwise cleared.
- Add policy-level coverage that proves flushing one turn does not flush another
  turn for the same binding.

**Patterns to follow:**
- Existing `turnIdForBackendEvent()` usage in
  `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Existing controller tests around "batches noisy default tool updates" and
  "flushes queued tool updates before assistant final text"

**Test scenarios:**
- Happy path: one turn exceeds the `Show Some` quiet threshold, then an
  assistant message for that same turn flushes only that turn's pending batch
  before the assistant message.
- Edge case: two turn ids on the same binding both have pending batches; flushing
  turn A leaves turn B pending until turn B's own timer or terminal event.
- Edge case: a binding-wide detach clears pending batches for all turns without
  sending stale messages afterward.
- Integration: overlapping Grok-like events for one binding produce no more than
  the intended quiet threshold for each actual turn, and do not emit unrelated
  batches before another turn's status.

**Verification:**
- The policy and controller tests prove turn-specific flush isolation while
  preserving the existing single-turn Codex behavior.

- [ ] **Unit 2: Improve Grok dynamic tool titles**

**Goal:** Make Grok-generated tool updates useful by extracting safe path/query
context from `dynamicToolCall` items.

**Requirements:** R4, R5

**Dependencies:** None

**Files:**
- Modify: `apps/desktop/src/main/messaging/core/messaging-tool-activity.ts`
- Test: `apps/desktop/src/main/__tests__/messaging-tool-activity.test.ts`

**Approach:**
- Extend dynamic tool title extraction to look at both tool-name fields and
  parsed argument/input objects.
- Map observed Grok tools to the same style as Codex summaries:
  - read-file shapes become `Read <basename>`
  - list-files shapes become `Listed <basename>` or `Listed files`
  - search-code shapes become `Searched <basename>` or `Searched code`
  - command-like dynamic tools continue using the existing safe command title
    path when a command string is present
- Preserve existing redaction and truncation behavior.
- Avoid including full paths when a basename communicates enough context.

**Patterns to follow:**
- Existing `commandActionTitle()` behavior in
  `apps/desktop/src/main/messaging/core/messaging-tool-activity.ts`
- Existing redaction tests in
  `apps/desktop/src/main/__tests__/messaging-tool-activity.test.ts`

**Test scenarios:**
- Happy path: Grok `dynamicToolCall` with `toolName: "read_file"` and a path
  argument summarizes as `Read <basename>`.
- Happy path: Grok `dynamicToolCall` with `toolName: "list_files"` and a path
  argument summarizes as `Listed <basename>`.
- Happy path: Grok `dynamicToolCall` with `toolName: "search_code"` and query
  plus path arguments summarizes as searched code with safe context.
- Edge case: missing path/query falls back to a generic but readable tool label,
  not an empty title.
- Error path: secret-looking dynamic tool arguments are not copied into the
  generated title.

**Verification:**
- Grok-like dynamic tool events no longer render as repeated `read file` or
  `search code` when safe path/query context exists.

- [ ] **Unit 3: Document the observed distinction and guardrail**

**Goal:** Capture the intended boundary so future changes do not regress the
Codex-good / Grok-noisy distinction.

**Requirements:** R1-R5

**Dependencies:** Units 1 and 2

**Files:**
- Modify: `docs/messaging-platform-integration.md`
- Modify: `docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md`

**Approach:**
- Add a short note that `Show Some` is turn-scoped and that binding-wide flushes
  are only for binding lifecycle cleanup.
- Mark the completed verbosity plan with a follow-up note that this hardening
  plan addresses live overlapping-turn behavior and Grok dynamic tool titles.

**Patterns to follow:**
- Existing `Tool Update Verbosity` section in
  `docs/messaging-platform-integration.md`

**Test scenarios:**
- Test expectation: none -- documentation-only unit.

**Verification:**
- The docs distinguish the intended Codex behavior from the hardening needed for
  overlapping turns and Grok summaries.

## System-Wide Impact

- **Interaction graph:** Backend events enter `MessagingController`, the
  controller updates `MessagingToolUpdatePolicy`, and providers only render the
  resulting message intents. This fix should not add provider-specific branches.
- **Error propagation:** Failed tools remain summarized as failed tool updates;
  delivery failures continue through existing adapter delivery outcomes.
- **State lifecycle risks:** The main risk is stale pending batches. Unit 1 must
  preserve binding-wide cleanup for detach/dispose while avoiding accidental
  cross-turn flushes.
- **API surface parity:** No public messaging contract changes are expected.
- **Integration coverage:** Controller tests should model overlapping turns on
  one binding because policy-only tests cannot catch the original integration
  bug.
- **Unchanged invariants:** Tool updates remain generated `role: "system"`
  messages and remain separate from assistant-authored responses.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Scoping flushes too narrowly leaves stale batches behind | Keep explicit binding-wide cleanup for detach/dispose and add tests for cleanup behavior |
| Grok title extraction accidentally leaks raw arguments | Reuse redaction/truncation helpers and add secret-like dynamic argument tests |
| Fixing Grok summaries changes Codex labels | Add Grok-specific dynamic tool coverage without weakening existing Codex `commandActions` tests |
| Overlapping-turn behavior remains possible in Grok | Treat overlapping turns as valid input and isolate per-turn state instead of assuming one active turn |

## Documentation / Operational Notes

- No rollout flag is needed. The change narrows unintended flush behavior and
  improves generated titles.
- Manual validation can reuse the same two live shapes: a Codex thread with
  normal tool batches and a Grok thread with overlapping dynamic tool calls.

## Sources & References

- Origin plan: `docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md`
- Related docs: `docs/messaging-platform-integration.md`
- Related code: `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- Related code: `apps/desktop/src/main/messaging/core/messaging-tool-update-policy.ts`
- Related code: `apps/desktop/src/main/messaging/core/messaging-tool-activity.ts`
