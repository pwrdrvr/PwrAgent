---
title: feat: Add Telegram topic ownership and monitor fanout
type: feat
status: completed
date: 2026-05-22
origin: docs/brainstorms/2026-05-22-telegram-topic-ownership-requirements.md
---

# feat: Add Telegram topic ownership and monitor fanout

## Overview

Add a Telegram-first topic ownership workflow so PwrAgent can manage a dedicated
control topic, maintain a local registry of known/adopted forum topics, propose
safe cleanup actions, and optionally fan recent PwrAgent thread monitoring out
into one Telegram topic per thread.

This plan deliberately preserves the current `/monitor` behavior. Topic fanout
is an explicit mode because creating or deleting Telegram topics changes the
shape of the supergroup and can remove message history.

## Problem Frame

The current messaging system can bind Telegram topics to PwrAgent threads and
can rename a topic through `setConversationTitle`. It does not have an owned
topic registry, topic creation/deletion/close operations, a control topic, or a
cleanup approval flow. Telegram's Bot API also does not provide a bot method to
list every forum topic in a supergroup, so cleanup must be honest about acting
on known or adopted topics only.

## Requirements Trace

- R1. Establish or adopt a Telegram control topic for supergroup maintenance.
- R2. Report whether Telegram admin rights support create/rename/close/reopen
  and delete operations.
- R3. Persist a local topic registry for owned, observed, and adopted topics.
- R4. Provide explicit adoption paths for existing topics.
- R5. Make cleanup dry-run by default and require approval for close/delete.
- R6. Never delete without explicit confirmation for the exact proposal item.
- R7. Prefer close-before-delete recommendations.
- R8. Add explicit topic-aware monitor fanout for recent changed threads.
- R9. Reuse an existing thread topic in the same supergroup instead of creating
  duplicates.
- R10. Seed newly created monitor topics with context.
- R11. Preserve existing `/monitor` card behavior.
- R12. Respect Telegram supergroup write budget.
- R13. Preserve actor and supergroup authorization.
- R14. Keep Telegram SDK/API details inside the Telegram provider.

## Scope Boundaries

- In scope: Telegram forum topic management through Bot API-backed provider
  capabilities, local topic registry persistence, command/control surfaces,
  dry-run cleanup proposals, approval callbacks, and topic fanout monitor
  behavior.
- In scope: focused operator docs explaining required Telegram permissions and
  the Bot API inventory limitation.
- Out of scope: MTProto/TDLib topic enumeration, autonomous deletion, broad
  cross-provider cleanup, and changing the current default `/monitor` card.
- Out of scope: renderer UI for the topic registry in the first implementation.

## Context and Research

### Telegram Bot API Constraints

- `ChatAdministratorRights.can_manage_topics` covers creating, renaming,
  closing, and reopening forum topics in supergroups.
- `deleteForumTopic` deletes a topic along with all messages and requires
  `can_delete_messages` in a supergroup.
- `forum_topic_created`, `forum_topic_edited`, `forum_topic_closed`, and
  `forum_topic_reopened` arrive as service-message fields on `Message`.
- No Bot API method lists all forum topics in a supergroup. Topic registry
  completeness must come from created topics, observed service messages, inbound
  messages, and explicit adoption.

### Existing Code and Patterns

- `packages/messaging/providers/telegram/src/telegram-adapter.ts` already
  recognizes topic service-message payloads, maps topic messages into
  `MessagingConversationKind: "topic"`, caches topic names, routes with
  `message_thread_id`, and implements `setConversationTitle` with
  `editForumTopic`.
- `packages/messaging/interface/src/index.ts` is the correct place for new
  provider-neutral capability types. It already defines generic channel refs,
  conversation refs, surface refs, adapter state, monitor subscription records,
  and callback handle storage.
- `apps/desktop/src/main/messaging/core/messaging-controller.ts` owns command
  dispatch, authorization-aware inbound handling, monitor subscriptions, timers,
  and managed delivery.
- `apps/desktop/src/main/state/state-db.ts` and
  `apps/desktop/src/main/state/messaging-store-sqlite.ts` are the durable
  sqlite path for profile-scoped messaging state.
- `apps/desktop/src/main/messaging/core/messaging-store.ts` remains the file
  store used by tests and legacy paths; store shape changes need parity there.
- `apps/desktop/src/main/messaging/core/messaging-command-catalog.ts` is the
  canonical messaging command catalog and help-surface source.
- `apps/desktop/src/main/messaging/core/messaging-monitor-card.ts` already
  selects pinned/recent threads and formats the existing monitor card.
- `docs-site/providers/telegram.md` already documents Telegram supergroup write
  budgets and General-topic edit limitations.

## Key Technical Decisions

- **Use provider-neutral topic-management capabilities.** Extend the messaging
  adapter contract with generic managed-conversation operations such as create,
  close, reopen, delete, and inspect rights. Implement them in Telegram only for
  this slice. Controller code should not import `grammy` or Telegram request
  types.
- **Persist topic state in desktop sqlite, not inside the provider.** Providers
  must not touch persistence. The provider reports observed topic lifecycle
  events and performs requested operations; the desktop store owns the registry,
  proposals, approvals, and thread-topic links.
- **Use dry-run proposal records for cleanup.** A cleanup sweep creates a durable
  proposal with action ids. Approvals execute only the selected proposal items
  and reject stale approvals when the proposal has expired or has already been
  applied.
- **Add a capability-aware topic command surface.** Prefer a new `topics`
  command if help rendering can hide unsupported commands by provider
  capability. If that becomes too wide for the first slice, use `/monitor topics`
  and `/monitor cleanup` subcommands so the existing monitor command owns the
  topic-aware extension without globally adding an unsupported command to every
  provider.
- **Keep topic fanout separate from channel monitor subscriptions.** A channel
  monitor updates one monitor card in one conversation. Topic fanout is a
  supergroup-level monitor mode that maps selected PwrAgent threads to topics.
- **Use one thread-topic link per supergroup.** The registry should key links by
  provider, supergroup id, backend, and thread id so repeated fanout can reuse an
  existing topic.
- **Prefer closing over deleting.** Cleanup scoring should default to keep or
  close proposals. Delete candidates require stronger evidence and still require
  explicit approval.

## Open Questions

### Resolved During Planning

- **Should cleanup be autonomous?** No. The user selected dry-run approval as the
  default safety mode.
- **Can the bot list all topics?** No official Bot API listing method exists.
  The feature must operate on known/adopted topics and explain that limitation.
- **Does the bot need extra permissions?** Yes for full operation: admin with
  topic-management rights for create/rename/close/reopen, and delete-message
  rights for topic deletion.

### Deferred to Implementation

- Exact command spelling: `/topics ...` versus `/monitor topics ...`.
- Exact staleness threshold defaults for close/delete candidates.
- Whether cleanup proposals expire after a fixed TTL or remain pending until
  superseded.
- Whether automatic topic renames follow PwrAgent thread title changes in the
  first slice or appear as cleanup proposals.

## Implementation Units

- [ ] **Unit 1: Extend provider-neutral managed-conversation capability**

**Goal:** Add a generic adapter capability for topic-like conversation
management while keeping Telegram API details isolated.

**Requirements:** R1, R2, R5, R6, R13, R14

**Files:**
- `packages/messaging/interface/src/index.ts`
- `packages/messaging/interface/src/__tests__/messaging-contract.test.ts`
- `docs/messaging-adapter-contract.md`

**Design Notes:**
- Add provider-neutral request/result types for managed conversation operations:
  rights probe, create child conversation, close, reopen, delete, and possibly
  adopt/resolve existing conversation.
- Use `MessagingChannelRef`, `MessagingConversationRef`, and
  `MessagingAdapterState` rather than provider ids in controller-facing types.
- Include operation-level support and failure reasons so the controller can
  render "missing topic-management rights" versus "missing delete rights."

**Test Scenarios:**
- Happy path: capability result type can express create/close/delete support
  without provider-specific fields.
- Edge case: unsupported providers can omit the capability and the controller can
  render an unsupported response.
- Regression: interface package still imports only allowed lower-layer packages.

- [ ] **Unit 2: Implement Telegram Bot API topic operations**

**Goal:** Teach the Telegram provider to create, close, reopen, delete, and
rights-check forum topics through the Bot API.

**Requirements:** R1, R2, R4, R6, R13, R14

**Files:**
- `packages/messaging/providers/telegram/src/telegram-adapter.ts`
- `packages/messaging/providers/telegram/src/__tests__/telegram-grammy-adapter.test.ts`
- `packages/messaging/providers/telegram/src/__tests__/telegram-adapter-security.test.ts`
- `packages/messaging/providers/telegram/src/__tests__/telegram-mention.test.ts`

**Design Notes:**
- Extend `TelegramBotApi`, `TelegramGrammyBotLike`, and `adaptGrammyBot` with
  Bot API methods needed for topic lifecycle and rights inspection.
- Keep `message_thread_id` and `chat_id` inside provider-owned opaque state or
  provider-local parsing.
- Continue capturing topic lifecycle service messages; emit enough normalized
  lifecycle information for the desktop controller/store to update the registry.
- Handle Telegram 400/403 failures as operation results that the controller can
  explain, not uncaught provider crashes.

**Test Scenarios:**
- Happy path: create topic maps to the grammY positional API and returns a topic
  channel ref with routing state.
- Happy path: close/reopen/delete map to the right Bot API calls.
- Happy path: rights probe reports topic-management and delete-message rights.
- Edge case: missing admin rights returns an operation failure with a user-safe
  reason.
- Edge case: General topic is not treated as a normal delete candidate.
- Regression: existing send/edit/pin/topic rename tests continue to pass.

- [ ] **Unit 3: Persist Telegram topic registry and cleanup proposals**

**Goal:** Add durable profile-scoped state for known topics, thread-topic links,
control topic configuration, and dry-run cleanup proposals.

**Requirements:** R1, R3, R4, R5, R6, R7, R9, R13

**Files:**
- `apps/desktop/src/main/state/state-db.ts`
- `apps/desktop/src/main/state/messaging-store-sqlite.ts`
- `apps/desktop/src/main/messaging/core/messaging-store.ts`
- `apps/desktop/src/main/messaging/core/messaging-migrations.ts`
- `apps/desktop/src/main/__tests__/messaging-store-sqlite.test.ts`
- `apps/desktop/src/main/__tests__/messaging-store.test.ts`

**Design Notes:**
- Add store methods for upserting observed/adopted/owned topics, finding the
  control topic by supergroup, linking a PwrAgent thread to a topic in a
  supergroup, and persisting cleanup proposals.
- Store provider-specific routing only as opaque adapter state; index on
  provider-neutral channel kind, supergroup conversation id, topic conversation
  id, backend, and thread id.
- Sanitize payloads with the existing secret-key pattern helpers before
  persistence.

**Test Scenarios:**
- Happy path: an observed topic round-trips through sqlite and file stores.
- Happy path: a thread-topic link prevents duplicate links for the same backend,
  thread id, and supergroup.
- Happy path: a cleanup proposal with selected actions persists and can be
  marked applied.
- Edge case: malformed opaque state is sanitized or ignored rather than
  crashing store reads.
- Regression: existing binding and monitor subscription rows still migrate and
  round-trip.

- [ ] **Unit 4: Add topic command/control flow**

**Goal:** Let authorized Telegram users establish the control topic, adopt
topics, request dry-run cleanup, and approve proposed cleanup actions.

**Requirements:** R1, R2, R4, R5, R6, R7, R13

**Files:**
- `apps/desktop/src/main/messaging/core/messaging-command-catalog.ts`
- `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- `apps/desktop/src/main/messaging/core/messaging-topic-control-card.ts`
- `apps/desktop/src/main/__tests__/messaging-command-catalog.test.ts`
- `apps/desktop/src/main/__tests__/messaging-controller.test.ts`

**Design Notes:**
- Add capability-aware command/help rendering if a new `topics` command is used.
  Otherwise extend `monitor` subcommand parsing and keep non-Telegram providers
  on the existing help surface.
- Render a control card showing known permissions, known/adopted topic count,
  pending cleanup proposal state, and available actions.
- Cleanup action callbacks must include proposal id and item id; stale or
  mismatched approvals render a recoverable error.
- Cleanup execution should rate-limit/batch close/delete calls and post a
  completion summary.

**Test Scenarios:**
- Happy path: authorized user can establish the current topic as the control
  topic.
- Happy path: adoption from inside a topic records that topic.
- Happy path: cleanup dry-run renders keep/close/delete/unknown groups without
  executing close/delete calls.
- Happy path: approving one close candidate executes only that proposal item.
- Edge case: unauthorized actor or unauthorized supergroup cannot manage topics.
- Edge case: stale approval is rejected and does not call the provider.
- Regression: `/help`, `/monitor`, `/status`, `/resume`, `/new`, and `/detach`
  continue to route as before.

- [ ] **Unit 5: Add topic-aware monitor fanout**

**Goal:** Let the control topic create or reuse per-thread Telegram topics for
recently changed PwrAgent threads and seed each created topic with context.

**Requirements:** R8, R9, R10, R11, R12, R13

**Files:**
- `apps/desktop/src/main/messaging/core/messaging-monitor-card.ts`
- `apps/desktop/src/main/messaging/core/messaging-topic-monitor.ts`
- `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- `apps/desktop/src/main/__tests__/messaging-monitor-card.test.ts`
- `apps/desktop/src/main/__tests__/messaging-controller.test.ts`

**Design Notes:**
- Reuse the existing navigation snapshot and monitor-thread selection helpers
  where possible, but add a "changed in window" selection layer for the
  topic-fanout command.
- Before creating a topic, query the topic registry for an existing link for
  the same supergroup, backend, and thread id.
- Seed only newly created topics. Existing linked topics should get at most a
  compact refresh/update unless explicitly requested.
- Respect Telegram supergroup write budgets by batching creates/posts and
  honoring provider rate-limit results.

**Test Scenarios:**
- Happy path: three recent changed threads create three topics and seed context.
- Happy path: rerunning fanout reuses existing links and creates no duplicates.
- Happy path: a thread already bound to a topic in the same supergroup is reused.
- Edge case: topic creation failure for one thread does not prevent other
  selected threads from being processed.
- Edge case: rate-limit response pauses or defers remaining topic writes instead
  of spinning.
- Regression: existing channel-level monitor subscriptions still render one
  monitor card and do not create topics.

- [ ] **Unit 6: Document Telegram setup, limitations, and operations**

**Goal:** Make the operator-facing docs clear about permissions, known-topic
limits, dry-run cleanup, and monitor fanout.

**Requirements:** R2, R5, R6, R11, R12

**Files:**
- `docs-site/providers/telegram.md`
- `docs-site/using-codex.md`
- `docs/messaging-platform-integration.md`

**Design Notes:**
- Document required admin rights separately for topic management and deletion.
- State plainly that Bot API cannot list every historical topic; adoption fills
  gaps.
- Explain the difference between normal `/monitor` and topic-aware monitor
  fanout.

**Test Scenarios:**
- Happy path: docs mention required Telegram rights and dry-run deletion safety.
- Happy path: docs link existing `/monitor` guidance to topic fanout without
  implying fanout is the default.
- Regression: docs-site link tests pass after adding anchors or links.

## Sequencing

1. Land provider-neutral capability types and Telegram provider operations.
2. Add store persistence for topic registry, thread-topic links, and cleanup
   proposals.
3. Add control/adoption/cleanup command flow with dry-run approvals.
4. Add topic-aware monitor fanout.
5. Update operator docs.

This sequencing keeps destructive operations behind a visible proposal flow
before adding fanout automation that can create many topics.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| User expects complete topic sweep, but Bot API cannot list all topics. | Say "known/adopted topics" in command output and docs; provide adoption commands. |
| Accidental destructive cleanup deletes messages. | Default to dry-run, require exact proposal approval, and make delete wording explicit. |
| Telegram permissions differ from what the user granted. | Add a rights probe and operation-specific failure messages. |
| Topic fanout floods the supergroup or hits 429s. | Batch topic creates/posts, reuse existing links, and honor provider rate-limit results. |
| Controller becomes Telegram-specific. | Add provider-neutral managed-conversation types and keep Telegram parsing/API calls in the provider. |
| Duplicate topics for the same thread create more mess. | Enforce one link per supergroup/backend/thread id and test reruns. |

## Verification

- `pnpm --filter @pwragent/messaging-provider-telegram test`
- `pnpm --filter @pwragent/desktop test -- apps/desktop/src/main/__tests__/messaging-controller.test.ts`
- `pnpm --filter @pwragent/desktop test -- apps/desktop/src/main/__tests__/messaging-store-sqlite.test.ts`
- `pnpm --filter @pwragent/desktop test -- apps/desktop/src/main/__tests__/messaging-monitor-card.test.ts`
- `pnpm lint:boundaries`
- Manual Telegram supergroup check with a test bot granted topic-management
  rights first, then delete-message rights for delete approval verification.
