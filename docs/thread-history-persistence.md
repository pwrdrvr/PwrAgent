# Thread History Persistence

Thread conversation history must not be stored in the desktop sqlite database.
The profile database is for structured desktop state: thread metadata, overlays,
launchpad defaults, messaging bindings, pending approvals, secrets, and similar
control-plane records. Full prompts, assistant messages, streamed transcript
updates, command output history, and provider rollout events do not belong in
sqlite payload columns.

## Source of Truth

- Codex App Server threads are restored from Codex-owned thread/session data.
  Desktop may add metadata and overlay records, but it must not keep a full
  duplicate transcript copy in `state.db`.
- ACP providers that support `session/load` should restore history from the ACP
  provider process. Desktop should cache only the session metadata needed to
  locate and resume that provider-owned session.
- Agent-Core/Grok stores conversation history in append-only per-thread JSONL
  rollout files, currently implemented by
  `packages/agent-core/src/persistence/grok-rollout-store.ts`.
- If an ACP provider cannot return history itself and PwrAgent must persist a
  fallback transcript, that fallback must use append-only JSONL rollout files,
  not sqlite.

## Desktop Metadata

Desktop may persist scalar metadata derived from history when it is needed for
navigation or safety checks. For ACP sessions, `hasConversationHistory` is the
intended marker for decisions such as whether a live workspace handoff is still
safe. The marker is allowed; the messages that caused it are not.

When reading legacy rows that accidentally contain transcript history, strip the
history before returning or re-writing the row. Preserve only metadata that is
needed for behavior, such as deriving `hasConversationHistory` from a legacy
user-message update.

## Future Shared Storage

The initial ACP fallback may use a narrowly scoped desktop-local append-only
JSONL store for providers that do not implement usable history loading. Before
expanding that fallback beyond the first provider-specific need, extract the
append-only JSONL rollout implementation into a shared library usable by both
Agent-Core and desktop ACP clients. The shared API should preserve the current
rollout properties: append-only writes, provider continuity metadata, replay
reconstruction, and path-specific errors for malformed rollout files.
