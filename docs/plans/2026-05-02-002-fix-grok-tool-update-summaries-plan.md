---
title: fix: Improve Grok tool update summaries
type: fix
status: completed
date: 2026-05-02
origin: docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md
---

# fix: Improve Grok tool update summaries

## Overview

Tighten the messaging tool-update feature after live Telegram testing showed
that Codex produces useful `Show Some` updates, while Grok `dynamicToolCall`
items can collapse into repetitive generic titles such as `read file` and
`search code`.

The earlier observation of two overlapping Grok turns is intentionally out of
scope for this plan. That is a separate messaging turn-admission bug: a bound
thread should not start a second turn while one is already active, and follow-up
messages should be queued or offered as a steer action instead.

## Problem Frame

The completed verbosity plan already chose channel-neutral tool updates,
turn-scoped batching, and generated `role: "system"` messages. Codex testing
validated that the core experience is close to the intended behavior: a few
quiet individual updates, then useful batches that include filenames, searches,
edits, and command names.

Grok emits different tool metadata. In the observed run, Grok used
`dynamicToolCall` items with tool names and argument objects such as paths,
queries, and limits. The current messaging summarizer does not extract enough
from those shapes, so the generated chat messages become generic and repetitive
instead of useful.

## Requirements Trace

- R1. Preserve the existing Codex behavior and `Show Some` thresholds.
- R2. Grok dynamic tool summaries should include safe path/query context when
  available.
- R3. Generated tool-update text must remain transcript-safe: no raw output, no
  full argument dumps, and no obvious secret values.
- R4. The fix must stay channel-neutral; Telegram and Discord adapters should
  continue rendering generic message intents.
- R5. The separate active-turn admission bug must remain out of scope for this
  plan.

## Scope Boundaries

- In scope: Grok `dynamicToolCall` title extraction and targeted tests for the
  observed tool shapes.
- In scope: preserving existing Codex `commandExecution` and `commandActions`
  summaries.
- Out of scope: changing the five verbosity modes, changing batching thresholds,
  changing Telegram/Discord rendering behavior, changing app-server protocols,
  redesigning Grok's tool execution model, or preventing overlapping turns.
- Out of scope: making every possible Grok tool label perfect. This pass should
  cover the concrete observed shapes: read file, list files, search code, and
  safe command-like dynamic tools.

## Context & Research

### Relevant Code and Patterns

- `apps/desktop/src/main/messaging/core/messaging-tool-activity.ts` owns safe
  tool title generation and already strips shell wrappers, redacts secrets, and
  handles Codex `commandActions`.
- `apps/desktop/src/main/messaging/core/messaging-renderer.ts` turns normalized
  tool activities into generated system messages and batched summaries.
- `apps/desktop/src/main/__tests__/messaging-tool-activity.test.ts` already
  covers safe shell command titles, file-change summaries, unknown item
  suppression, and secret redaction.
- `apps/desktop/src/main/__tests__/messaging-controller.test.ts` and
  `apps/desktop/src/main/__tests__/messaging-tool-update-policy.test.ts` already
  cover the current batching policy; those should remain unchanged unless title
  improvements require fixture updates.

### Institutional Learnings

- `docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md`
  established generated tool updates as channel-neutral system messages.
- `docs/messaging-platform-integration.md` documents the intended default:
  `Show Some` sends a few individual updates and batches noisy activity.

### External References

- External research is not needed. This is an internal event-normalization fix
  grounded in captured PwrAgent behavior.

## Key Technical Decisions

- **Improve Grok labels in the summarizer, not in providers.** Telegram and
  Discord should continue to render the same generic system message intents.
- **Prefer safe basename/query summaries over raw argument dumps.** Path and
  query context is useful; full dynamic tool arguments may contain bulky data or
  sensitive strings and should not be blindly serialized.
- **Preserve Codex-first behavior.** Existing `commandExecution` and
  `commandActions` summaries are already useful and should not regress.
- **Keep overlapping-turn prevention separate.** The right fix for split
  Telegram messages is turn admission and queue/steer behavior, not changing
  tool-update batching in this plan.

## Open Questions

### Resolved During Planning

- **Is there concrete work here after excluding overlapping turns?** Yes. Grok
  dynamic tool summaries still need bounded title extraction improvements.
- **Should the fix change global `Show Some` thresholds?** No. Codex testing
  shows the current thresholds are close to the intended experience.
- **Should this plan prevent two turns from starting in the same bound thread?**
  No. That is a separate queue/Steer plan.

### Deferred to Implementation

- Exact extraction rules for less common Grok dynamic tool names are deferred
  until implementation inspects the observed item shapes already present in
  fixtures or protocol captures.
- Whether to promote any Grok protocol capture into a durable replay fixture is
  deferred; focused unit coverage may be enough for this summary-only change.

## Implementation Units

- [x] **Unit 1: Improve Grok dynamic tool titles**

**Goal:** Make Grok-generated tool updates useful by extracting safe path/query
context from `dynamicToolCall` items.

**Requirements:** R1, R2, R3, R4

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
- Happy path: Grok `dynamicToolCall` with a command string still uses the
  existing safe command-title path.
- Edge case: missing path/query falls back to a generic but readable tool label,
  not an empty title.
- Error path: secret-looking dynamic tool arguments are not copied into the
  generated title.
- Regression: existing Codex `commandExecution` and `commandActions` tests keep
  producing the same titles.

**Verification:**
- Grok-like dynamic tool events no longer render as repeated `read file` or
  `search code` when safe path/query context exists.

- [x] **Unit 2: Document the Grok summary guardrail**

**Goal:** Capture why this plan only improves Grok title quality and does not
change batching semantics.

**Requirements:** R1-R5

**Dependencies:** Unit 1

**Files:**
- Modify: `docs/messaging-platform-integration.md`
- Modify: `docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md`

**Approach:**
- Add a short note that generated update usefulness depends on backend tool
  metadata quality and that Grok dynamic tools need path/query extraction.
- Add a follow-up note to the completed verbosity plan linking this summary
  hardening plan.
- Keep overlapping-turn prevention documented elsewhere when the queue/Steer
  plan is written.

**Patterns to follow:**
- Existing `Tool Update Verbosity` section in
  `docs/messaging-platform-integration.md`

**Test scenarios:**
- Test expectation: none -- documentation-only unit.

**Verification:**
- The docs explain the Grok summary improvement without implying a batching
  redesign.

## System-Wide Impact

- **Interaction graph:** Backend events enter `MessagingController`,
  `messaging-tool-activity.ts` normalizes tool labels, and providers render the
  resulting generic message intents.
- **Error propagation:** Failed tools remain summarized as failed tool updates;
  delivery failures continue through existing adapter delivery outcomes.
- **State lifecycle risks:** No persistence or lifecycle state changes are
  expected.
- **API surface parity:** No public messaging contract changes are expected.
- **Integration coverage:** Unit tests should be enough because this changes
  title normalization, not delivery sequencing.
- **Unchanged invariants:** Tool updates remain generated `role: "system"`
  messages and remain separate from assistant-authored responses.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Grok title extraction accidentally leaks raw arguments | Reuse redaction/truncation helpers and add secret-like dynamic argument tests |
| Fixing Grok summaries changes Codex labels | Add Grok-specific dynamic tool coverage without weakening existing Codex `commandActions` tests |
| Less common Grok tools remain generic | Treat this pass as observed-shape coverage and leave unknown tools with readable generic fallbacks |

## Documentation / Operational Notes

- No rollout flag is needed. The change only improves generated titles.
- Manual validation can reuse a Grok thread that performs read, list, and search
  dynamic tools, plus a Codex thread to confirm existing labels remain good.

## Sources & References

- Origin plan: `docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md`
- Related docs: `docs/messaging-platform-integration.md`
- Related code: `apps/desktop/src/main/messaging/core/messaging-tool-activity.ts`
- Related code: `apps/desktop/src/main/messaging/core/messaging-renderer.ts`
