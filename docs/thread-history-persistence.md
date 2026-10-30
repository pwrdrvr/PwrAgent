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
- The Claude SDK backend keeps its desktop history in append-only JSONL under
  the active profile's `state/claude/`. Before appending a persistent entry,
  retain supported inline image parts in the content-addressed
  `state/thread-images/claude/<thread-id>/` cache and store transcript-image
  protocol URLs in their place. Revisions reuse the image file; legacy inline
  entries remain readable without rewriting history. Ephemeral sessions stay
  in memory, including their images.

## Desktop Metadata

Desktop may persist scalar metadata derived from history when it is needed for
navigation or safety checks. For ACP sessions, `hasConversationHistory` is the
intended marker for decisions such as whether a live workspace handoff is still
safe. The marker is allowed; the messages that caused it are not.

When reading legacy rows that accidentally contain transcript history, strip the
history before returning or re-writing the row. Preserve only metadata that is
needed for behavior, such as deriving `hasConversationHistory` from a legacy
user-message update.

## Tracked review findings

`thread_reviews` (see [thread-reviews.md](thread-reviews.md)) is the one
sqlite table that keeps review text. A tracked review is a work-queue record:
its To-do card must render, and its open findings must reach an agent, after
the transcript that produced it has scrolled out of the loaded history or the
agent's context. It is not a copy of the thread, and two rules keep it that
way.

- **Excerpts only.** Each record keeps the review title, a summary, and each
  finding's title, body, priority, and code location, capped by
  `THREAD_REVIEW_TEXT_LIMITS` in
  `apps/desktop/src/main/thread-reviews/thread-review-service.ts`: 300
  characters per title, 1,000 for the summary, and 4,000 per finding body.
  No other transcript content is stored: no prompts, no surrounding
  messages, and no tool output.
- **The transcript never renders from it.** The transcript's review card
  draws every finding's text from the transcript entry. It reads only state
  from the record: status, the resolution note, the actor, the evidence link,
  and the time. The To-do card, the finding titles in the "Fix N findings"
  reply, and the agent's `list_reviews` tool are the only consumers of the
  stored text.

Extend this exception only by updating this section. Any other table that
stores history text needs its own documented exception.

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
