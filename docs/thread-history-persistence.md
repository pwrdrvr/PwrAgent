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

## Future Fallback Storage

An ACP fallback may use a narrowly scoped desktop-local append-only JSONL store
for providers that do not implement usable history loading. Keep any such API
provider-neutral and preserve append-only writes, provider continuity metadata,
replay reconstruction, and path-specific errors for malformed rollout files.

## Cross-thread correspondence

PwrAgent stores supplemental outbound messages in the active profile's
`state/thread-correspondence/<thread-identity-hash>.jsonl`. A message event holds
its full input once; later status events contain only delivery metadata. These
are PwrAgent's own correspondence records, not a copy of provider history.
They are materialized as ordinary transcript messages on the sender's latest
history page, so activity rollup and renderer reload do not discard them.

The recipient FIFO remains owned by its main process. Navigation snapshots
contain only previews. `readQueuedTurn` reads one entry through its owner;
editing recovers content before cancellation and compares a content hash to
reject concurrent input changes. Federated editing recovers attachment bytes
on the owner before removing the entry. A failed read or transfer leaves the
queue intact. Queued status records mean last confirmed queue admission,
not delivery; peer cancellation and process restart can make that observation
stale. Local queue lifecycle events record cancellation, failure, and holds.
The existing in-memory FIFO is not made restart-persistent by this store.
