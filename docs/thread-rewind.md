# Thread Rewind

A rewind takes a thread back to before one of its prompts. That prompt's turn
and every later turn leave the conversation, and the prompt's text returns to
the composer so the operator can edit and resend it.

## What each provider can put back

The UI offers only what the provider does. `BackendCapabilities.threadRewind`
carries it; a backend without the field offers no rewind. A federation owner
that predates generic rewind never sets the field, so a viewer never offers a
rewind the owner would refuse. The owner's summary decides: a peer's thread
pinned in the main window reads the peer's backend summaries, not this
window's.

| Provider | Conversation | Files | Undo |
|---|---|---|---|
| Codex | `thread/revert` `{ threadId, beforeTurnId }`, Codex 0.153 or later (`supportsThreadRevert` in `protocol-compatibility.ts`). Readers rehydrate the retained history through `thread/turns/list`. | No. The protocol leaves local files as they are. | No. Codex replaces the history. |
| Claude | A query resumes the thread's SDK session at the entry before the prompt (`resumeSessionAt`) and continues on a new branch of the same session. See [claude-provider.md](claude-provider.md#rewind). | Yes, through `Query.rewindFiles` with checkpointing on every query: what Edit, Write, and NotebookEdit changed. Not shell commands, and not prompts sent before checkpointing. | Yes, the latest rewind, until the next turn starts. The removed branch stays in Claude's session, and PwrAgent keeps a copy of the files a rewind restored. See [claude-provider.md](claude-provider.md#undo). |
| Grok Build | `_x.ai/rewind/execute` with `mode: "conversation_only"`. Grok counts rewind points by prompt; the ACP adapter resolves the transcript message to its ordinal among the session's user messages, and refuses unless Grok's point at that index previews the same prompt. A user message Grok does not count would otherwise move the irreversible rewind onto a later prompt. | No. Grok's binary declares `files_only` and `code_only` rewind modes, but their behavior is undocumented, so PwrAgent does not use them. | No. |

## Contract

- `RewindThreadRequest` names the target as the transcript user message and,
  when the provider reports one, its turn (`ThreadRewindTarget`). Codex rewinds
  by turn, so a Codex prompt without a turn is not a target. `mode` is
  `"conversation"` or `"conversation-and-files"`; a provider that cannot
  restore files refuses the second.
- `DesktopBackendRegistry.rewindThread` refuses while a turn runs, runs the
  provider rewind, and emits `thread/rewound`. Codex's own `thread/reverted`
  notification, from any client, also becomes `thread/rewound`; when Codex
  announces a revert while the request is in flight, the registry does not
  announce it again. The renderer and navigation already reload a thread on
  that event.
- A Codex revert holds the thread's start reservation, so a reply sent
  meanwhile is queued. The registry drains the queue when the revert ends.
- Remote threads go through the federation method `backend.rewindThread`,
  which needs the `turn_control` capability.
- Each rewind is recorded in the thread's `rewindLog` overlay, before
  `thread/rewound` is announced: when, how many turns it removed (counted by
  the renderer and sent as `removedTurnCount`), how many files it restored,
  and whether the provider can undo it. A Codex revert in flight is
  announced by the registry alone, after its record, rather than by Codex's
  own notification.
- `UndoThreadRewindRequest` names a rewind by its `rewindId`.
  `DesktopBackendRegistry.undoThreadRewind` refuses one the log does not
  mark undoable, asks the provider (Claude only), marks the record undone,
  and emits `thread/rewound`. Federation method `backend.undoThreadRewind`,
  also `turn_control`.

- `PreviewThreadRewindRequest` reads what a rewind would put back without
  changing anything. Only Claude answers it with files, from a dry run; its
  `unavailableReason` blocks the rewind (a running task, a prompt Claude no
  longer has) and `filesUnavailableReason` disables only the file option.

## Renderer

The rewind sits beside Copy in a prompt's hover actions (`TranscriptMessage`),
on the first prompt of each turn (`collectRewindableMessageIds`). It opens
`ThreadRewindConfirm` under that prompt: how many later turns go, a Restore
files option shown disabled with its reason when the provider cannot restore
files, and whether the rewind can be undone. Where the provider restores
files, the confirmation previews them first and holds the confirm button until
the dry run answers; Restore files is then on, with the count, the line
totals, and the first few paths. The thread header's History
button opens the same confirmation on the last prompt, which is the keyboard
path. The counts come from the loaded transcript (`summarizeThreadRewind`),
which always runs contiguously from the target to the end. A collapsed history
entry hides its file details, so the file count is omitted then.

After the provider accepts, the composer takes the prompt back through its
`draftRestore` prop, parking any draft in progress in the recovery journal.
A Rewound prompt chip marks it until the composer is cleared or shows
another thread.
`rewoundPrompt` returns the text and each image the composer can send again:
a local image shown through `pwragent-image://file/` goes back as its
`localImage` input, and inline or web images resend by URL. A file part
carries no path and a peer's image is not this machine's file, so those are
left out and a notice says how many to attach again.

One marker row stands where a rewind removed turns (`rewind-marker-entries.ts`),
placed by the time of the rewind: "Rewound 2 turns · restored 2 files". It
offers Undo on the latest rewind only, while its provider can undo it and no
message has followed it. An undone rewind has no marker.
