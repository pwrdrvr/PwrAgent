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
  the active profile's `state/claude/`. This is the fallback copy described
  above: Claude's own session cannot return the history PwrAgent shows. See
  [Claude history](#claude-history) for the evidence. Before appending a persistent entry,
  retain supported inline image parts in the content-addressed
  `state/thread-images/claude/<thread-id>/` cache and store transcript-image
  protocol URLs in their place. Revisions reuse the image file; legacy inline
  entries remain readable without rewriting history. Ephemeral sessions stay
  in memory, including their images.

## Claude history

A Claude thread has two copies of its conversation:

- PwrAgent's transcript, `state/claude/<thread-id>.jsonl`. It renders the
  thread and has no age limit.
- Claude Code's session, which the next turn resumes by `sdkSessionId` (or a
  fork's `forkFromSdkSessionId`). Claude Code deletes a session that has been
  idle longer than its `cleanupPeriodDays` setting, 30 days by default.

### Why PwrAgent keeps its own copy

PwrAgent keeps its own copy, because the Agent SDK's reader
(`getSessionMessages`) cannot replace it. This was decided on 2026-11-02,
from measurements of 337 threads made through the SDK API with
`@anthropic-ai/claude-agent-sdk` 0.3.310:

- **Compaction hides earlier turns.** The reader returns only the
  conversation after the last compaction: a system boundary, the summary, and
  the turns that followed. 73 of the 337 threads had compacted. 414 of the
  1,445 prompts sent since prompt UUIDs became turn ids (#2878) were missing
  from the reader, and every one of them was in a compacted thread. The Codex
  App Server still returns turns from before a compaction, which is why Codex
  can be the source of truth.
- **Claude Code deletes old sessions.** It removes transcripts older than
  `cleanupPeriodDays`, which defaults to 30 days. A PwrAgent thread has no
  such limit. See
  [After Claude Code deletes the session](#after-claude-code-deletes-the-session).
- **The reader leaves out fields PwrAgent shows.** It has no
  `tool_use_result`, which file diffs (`structuredPatch`), artifact links and
  background-task launches come from. It also has no turn status and no turn
  end. Reviews, plans, notices and retained images exist only in PwrAgent.
  Each message does carry an ISO `timestamp`, though the SDK type omits it.
- **Sub-agents are separate.** Their messages are not in the main
  conversation. `listSubagents` and `getSubagentMessages` return them.
- **Reading it is not cheaper.** For these threads Claude's files are
  2,160 MB and PwrAgent's are 784 MB. The reader parses the whole file on
  every call, including `limit`/`offset` calls, and `offset` counts from the
  oldest message. The largest session (43 MB) took 50 to 70 ms with or
  without a limit. A plain read of PwrAgent's copy took 3 ms at the median
  and 64 ms at most.
- **It reads the host's config directory.** The reader uses the PwrAgent
  process's `CLAUDE_CONFIG_DIR`, not the environment a turn launches Claude
  with.

The reader does follow the branch Claude continues. After a rewind and a new
turn, it returns the new branch, as PwrAgent's truncation records do. Before
that turn, it still returns the removed turns. A query-side fork
(`resume` with `forkSession`) keeps the source's message UUIDs and timestamps.
The `forkSession()` function gives the copied messages new UUIDs. An
ephemeral session (`persistSession: false`) has nothing to read.

PwrAgent still uses the reader to find a rewind's point: a prompt's SDK UUID
is its turn id. Prompts sent before #2878 have no such mapping.

Revisit this decision only if Claude's reader returns turns from before a
compaction and PwrAgent can keep sessions past `cleanupPeriodDays` without
changing the operator's setting. The SDK's `sessionStore` option does not
help here. It mirrors the transcript to a third copy, and it is alpha.

### After Claude Code deletes the session

After Claude Code deletes the session, the thread still reads correctly, but
Claude cannot continue it or rewind it:

- A resume fails before the session starts. Claude Code answers with an
  `error_during_execution` result whose error is
  `No conversation found with session ID: <id>`, and sends no `init`.
  The backend matches that error only when it names the session the launch
  resumed. The turn then fails with a message that says Claude no longer has
  the conversation. Any other resume failure keeps Claude's own message.
- A rewind reads the session as empty. When `getSessionInfo` also finds the
  session in no project folder, the preview and the rewind both say Claude
  no longer has the conversation.

The thread keeps its `sdkSessionId`. PwrAgent never changes the operator's
`cleanupPeriodDays`: Claude Code applies it to every session on the machine,
not only PwrAgent's.

### Copy size

On 2026-11-02 the default profile's copy was 784 MB for 337 threads, written
in 13 days. The latest revision of each entry was 363 MB. Another 363 MB was
the same entries written again at turn end only to record the turn's final
status. Tool output was 209 MB of the latest revisions.

A turn now ends with one `pwragent_turn_end` line: the turn id, its status,
and its start and end times. Reading the history gives every entry of that
turn the status, including a task row saved after the turn ended. At turn end
the backend writes again only an entry whose content was never saved, such as
an answer still streaming when the turn was cancelled. It compares a hash of
each entry, without its turn status, with the hash taken when it was last
saved. The 1,925 turns in the measured profile need about 0.3 MB of these
lines. A tool row is still saved when it starts, about 55 MB in that profile,
so a crash still shows the tool as running.

A scripted turn with six tool calls, each with 2.2 KB of output, and a
480-character answer wrote 40,285 bytes before the change and 21,023 bytes
after it, 48% less. The entries read back the same, 42 entries in 58,320
bytes over three turns.

Files written before the change stamp every entry instead, and read the same.
Nothing rewrites them. A fork copies the entries with their stamps applied,
so its file has no turn-end lines.

A build from before the change does not know the line. After a downgrade,
turns written by a newer build show no final status. That build also reads
the line as one entry with no id, and its rewind undo counts it as an entry
saved after the rewind.

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

## Project-held wake-ups

`project_held_wakeups` keeps the input of a wake-up that a paused project
holds: a finished task monitor's handoff to its parent, or a Continue After
prompt. Both sources are consumed when the wake-up is held, so without this
row a restart loses it. It is unsent input, not history, and two rules keep
it that way.

- **One row per held entry, deleted when the entry leaves the queue.** The
  turn starting, a failed start, and the operator's Discard each delete it.
  After Send, the row stays until the turn starts, so a restart in between
  holds the wake-up again instead of losing it.
- **Nothing renders from it.** At startup the registry puts the rows back in
  the turn queue as paused, project-held entries. The transcript shows the
  input only once the turn runs, from the provider's own history.

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

## Failed environment launches

A launch request whose environment setup failed has not reached the provider.
The owner retains that unsent request under the active profile's
`state/pending-environment-launches/<thread-identity-hash>.json`, outside SQLite.
Continuation reads the request on the owner, preserving its input, review or
schedule, and launch settings across viewer reloads and owner restarts. Failed
continuations retain it; successful admission removes it. This is pending work,
not a provider transcript copy. A legacy thread with no retained request asks
the operator to send the prompt again rather than silently dismissing startup.
