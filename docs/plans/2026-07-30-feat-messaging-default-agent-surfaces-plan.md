---
title: "feat: Add provider-neutral default Agent messaging surfaces"
type: feat
date: 2026-07-30
---

# Provider-neutral default Agent messaging surfaces

## Summary

Replace PR #861's side-channel control routing with a smaller workflow built on
ordinary messaging bindings and provider-managed child conversations.

An operator explicitly assigns an eligible Agent as the default for a
normalized messaging scope. An authorized, addressed message in an unbound
surface resolves that assignment, chooses a bindable placement from normalized
conversation kind and adapter capabilities, creates a normal Agent-thread
binding there, and submits the message through normal turn admission. From then
on, the conversation is an ordinary bound messaging surface.

Ordinary bound work-thread turns also retain their live messaging origin. That
lets existing `handoff_task` messaging attachment behavior and
`attach_thread_here` understand "this channel" without a second Agent route.

## Product Contract

### Explicit default management

- Default Agent assignment is persisted separately from
  `MessagingBindingRecord`.
- `/agent` keeps its current behavior: browse or create an Agent and bind the
  current conversation.
- `/agent default` shows the effective default, the scope that supplied it, and
  whether an exact assignment exists for the current conversation.
- `/agent default set [conversation|parent|workspace|provider|profile]` opens
  the existing Agent picker in an explicit default-assignment continuation.
- Selecting an Agent from that continuation replaces the assignment at the
  requested scope. It does not bind the current conversation and cannot happen
  as a side effect of ordinary `/agent` browsing.
- `/agent default clear [conversation|parent|workspace|provider|profile]`
  revokes only that scope's assignment and then shows the newly effective
  fallback.
- The no-argument `set` and `clear` operations target the exact conversation.
  Scope options that cannot be expressed by the normalized inbound surface are
  reported as unavailable rather than guessed from provider-native IDs.

### Resolution hierarchy

The generic contract uses a discriminated assignment scope and an explicit
Agent target:

```ts
type MessagingDefaultAgentTarget = {
  kind: "agent";
  backend: AppServerBackendKind;
  threadId: ThreadIdentifier;
};

type MessagingDefaultAgentScope =
  | { kind: "conversation"; channel: MessagingChannelRef }
  | { kind: "parent"; channel: MessagingChannelKind; conversationId: string }
  | { kind: "workspace"; channel: MessagingChannelKind; workspaceId: string }
  | { kind: "provider"; channel: MessagingChannelKind }
  | { kind: "profile" };
```

Resolution evaluates the normalized inbound surface from most to least
specific:

1. exact conversation identity, including thread/topic identity
2. explicit normalized parent/channel identity
3. explicit normalized workspace/server/team identity
4. provider
5. PwrAgent profile

The adapter contract gains normalized hierarchy identifiers where current
fields are insufficient. Providers populate them at their boundary. Desktop
core only builds and compares generic scope keys; it never parses
`routingState.opaque` or provider-native identifiers.

For Slack, a root channel assignment is an exact conversation assignment. The
adapter already normalizes app mentions and retains the source timestamp in
opaque routing state for managed-conversation creation. It will additionally
expose the workspace/team identifier through the normalized hierarchy contract
where available.

### Assignment integrity

- Assignment records are a discriminated union; malformed scoped records are
  rejected during JSON migration instead of being widened to profile scope.
- A scope has at most one active assignment.
- JSON replacement occurs under the store's existing serialized write queue.
- SQLite replacement revokes the previous row and inserts the replacement in
  one transaction.
- SQLite has a partial unique index on the active scope key so multiple app
  instances cannot create competing active assignments.
- Clearing is a revocation, preserving audit history.
- Resolution validates that the target is still an available eligible Agent.
  Stale assignments are revoked and lookup continues at the next broader scope.
- Thread archive events best-effort revoke assignments targeting the archived
  Agent, while resolution remains the correctness backstop for missed events or
  restarts.

### Eligible Agent backends

The required bootstrap prompt depends on `search_threads`, `read_thread`,
`send_message_to_thread`, and `attach_thread_here`.

The first implementation explicitly limits default assignment to Codex Agent
threads because current main only guarantees the complete PwrAgent dynamic-tool
set for Codex. The picker filters to:

- `thread.source === "codex"`
- Agent metadata is present
- the thread is present in the current navigation snapshot

This is an explicit product constraint, not an assumption that every Agent
backend has Codex tools. A future backend can become eligible through a shared
backend capability once it supplies the same tool contract.

### Addressed unbound bootstrap

The bootstrap applies only when all of these are true:

- the inbound event is authorized by the existing actor/conversation gates
- it is text with `botMention === true`
- the normalized conversation has no active binding
- a valid default resolves

The controller then resolves placement generically:

1. If the normalized inbound conversation kind is `thread` or `topic`, use
   `current_conversation`. The existing child is already a safe bindable
   placement; no adapter create call is needed.
2. Otherwise, ask `getManagedConversationRights` when available and call
   `createManagedConversation` only when `create_child` is supported for the
   source event.
3. If neither current-conversation placement nor safe child creation is
   available, return a capability error without creating a binding or admitting
   a turn.
4. Create a normal `agent_thread` binding for the selected current or returned
   child conversation.
5. Deliver the initial status surface. For Slack root mentions, this reply
   materializes the Slack thread.
6. Admit the original text through the existing turn-admission path, rewriting
   the event channel/routing state only when the adapter returned a new child.

The original actor, text, and routing state remain intact. Mutable conversation
labels are not interpolated into privileged Agent instructions.

If child creation is needed but unsupported, denied, or fails, the controller
sends a clear capability error to the source surface and creates no binding. It
does not invent an ephemeral binding or submit a side-channel turn.

Unaddressed ambient messages in unbound shared channels retain current behavior.
Commands, callbacks, media handling, authorization, queueing, steering, and
normal bound delivery continue through their existing paths.

### Ordinary bound-turn origin parity

`rememberAgentMessagingOrigin` should record every live inbound messaging turn
whose backend has the messaging tool contract, including ordinary Codex work
threads. A concrete `turnId` plus the live inbound event makes this
unambiguous.

The no-turn fallback remains conservative:

- Agent-thread bindings remain eligible.
- Handoff-origin bindings remain eligible.
- Ordinary work-thread bindings do not become eligible without a concrete live
  turn.
- Multiple fallback bindings still fail with `ambiguous_location`.

This preserves the originating actor and surface for ordinary bound Codex turns
without making lifecycle/no-turn tool calls guess a location.

## Implementation Units

### 1. Contract and persistence

- Add normalized hierarchy fields and default-assignment types to
  `@pwragent/messaging-interface`.
- Bump the JSON messaging store version and migrate only structurally valid
  assignments.
- Add assignment CRUD, replacement, resolution candidate lookup, target revoke,
  and snapshot parity to JSON and SQLite stores.
- Add a SQLite table, active-scope partial unique index, and state DB migration.
- Cover malformed records, specificity, transactional replacement, uniqueness,
  clearing, stale-target revocation, fresh schema, and previous-version reopen.

### 2. Explicit management

- Parse the `default` subcommand under `/agent`.
- Add scope parsing and a compact status/management confirmation surface.
- Extend browse-session continuation state for explicit default assignment.
- Filter that picker to eligible Codex Agent threads.
- On selection, set the requested assignment and render confirmation without
  changing any active messaging binding.
- Add callback actions for set/change and clear at the exact scope.

### 3. Bootstrap and origin parity

- Resolve valid defaults for addressed, unbound text.
- Bind an existing normalized child conversation in place, or create an
  adapter-managed child from a root conversation when supported.
- Submit through existing turn admission and preserve the original actor and
  normalized origin.
- Revoke stale targets and continue fallback resolution.
- Record live ordinary Codex messaging origins by turn while preserving the
  conservative no-turn fallback.
- Cover Slack-shaped, Telegram-shaped, Discord-shaped, unsupported-capability,
  ambient-message, authorization, stale-target, and ordinary-bound-origin
  paths in focused controller tests.

## Acceptance

1. `/agent default` can inspect, explicitly set/change, and clear a Slack
   channel's exact default without changing its current binding.
2. Selecting an Agent in ordinary `/agent` browsing never persists a default.
3. An authorized `@PwrAgent ...` message in an unbound Slack channel with a
   default creates a Slack reply-thread binding to that Agent and starts the
   normal bound turn with the real actor and origin.
4. The Agent can use existing thread search/read/send tools, then
   `attach_thread_here` with `placement=current_conversation` to replace the
   Slack reply-thread binding with the chosen work thread.
5. An authorized addressed message in an unbound normalized Telegram topic or
   Discord/Slack thread binds that existing conversation to the default Agent
   and admits the turn without calling `createManagedConversation`.
6. An ordinary bound Codex turn can call `handoff_task` with
   `messagingAttachment` or `attach_thread_here` using its concrete turn
   origin.
7. Telegram topics and Discord threads resolve exact and normalized parent
   fallbacks without desktop core parsing native IDs.
8. A root-like surface whose provider cannot create a bindable child returns a
   capability error and receives no Agent turn.

## Verification

```bash
pnpm test apps/desktop/src/main/__tests__/messaging-store.test.ts
pnpm test apps/desktop/src/main/__tests__/messaging-store-sqlite.test.ts
pnpm test apps/desktop/src/main/__tests__/state-db.test.ts
pnpm test packages/messaging/interface/src/__tests__/messaging-contract.test.ts
pnpm test packages/messaging/providers/slack/src/__tests__/slack-adapter.test.ts
pnpm test packages/messaging/providers/telegram/src/__tests__/telegram-grammy-adapter.test.ts
pnpm test packages/messaging/providers/discord/src/__tests__/discord-adapter.test.ts
pnpm test apps/desktop/src/main/__tests__/messaging-controller.test.ts
pnpm test apps/desktop/src/main/__tests__/backend-registry.test.ts
pnpm lint:eslint
pnpm lint:boundaries
pnpm typecheck
```

## Implementation Status

Completed on 2026-07-30:

- [x] Provider-neutral assignment contract, specificity lookup, JSON/SQLite
  parity, and state DB version 32 migration.
- [x] Explicit `/agent default` inspect/set/change/clear workflow without
  implicit persistence from ordinary Agent browsing.
- [x] Existing-child and root-to-managed-child addressed bootstrap through
  ordinary bindings and turn admission.
- [x] Live origin parity for ordinary bound Codex turns with the conservative
  no-turn fallback unchanged.
- [x] Slack, Telegram, and Discord hierarchy normalization, including
  compatibility lookup for legacy channel-shaped Discord thread bindings.
- [x] Stale-target fallback cleanup and proactive archive cleanup.

Executed verification:

- Focused controller, store, migration, Slack, Telegram, and Discord suites:
  442 tests passed.
- Messaging interface and backend-registry suites: 397 tests passed.
- `pnpm lint:eslint`: passed with zero errors (baseline warnings remain).
- `pnpm lint:boundaries`: passed with no dependency violations.
- `pnpm lint:sql`: passed.
- `pnpm typecheck`: passed for all workspace projects.

## Deferred

- `/agent <request>` side-channel routing from an already bound surface.
- Ephemeral control bindings, controller-local turn ownership maps, custom
  delivery filtering, and alternate backend FIFO routing.
- Automatic default persistence from ordinary Agent browsing.
- Non-Codex default Agents until a shared backend capability guarantees the
  required PwrAgent tools.
- Settings-window management UI. Messaging commands/buttons/pickers are the
  first complete operator surface.
- Automatic use of a default for unaddressed ambient shared-channel messages.
- Provider-native scope inference in desktop core.
