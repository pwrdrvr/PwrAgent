# Messaging Platform Integration

PwrAgent can run messaging adapters from the Electron main process so an
allowlisted Telegram or Discord user can choose a thread, bind the current
conversation, and send free-form text into that thread. The workflow logic is
shared; Telegram and Discord only own transport, formatting, callback handles,
and platform limits.

## Commands

The supported command surface is:

- `/resume` opens the recents browser, with Projects and New-thread navigation.
- `/threads` is an alias for choosing a thread.
- `/bind` is an alias for choosing a thread.
- `/status` refreshes the pinned binding/status card.
- `/detach` detaches the conversation and unpins the status card where the platform supports it.

Telegram registers these commands at startup with `setMyCommands`. Telegram
clients can cache command menus, so if old OpenClaw commands still appear,
restart or reopen the bot menu after starting PwrAgent.

### `@<bot> <verb>` text-mention alternative

On Telegram and Discord, the same verbs can be invoked by mentioning the bot
followed by the verb — for example `@PwrAgent resume` or `@PwrAgent help`.
The mention path is recognized before the slash-prefix path and dispatches the
identical `MessagingInboundCommandEvent` the slash form produces, so workflow
behavior is the same regardless of invocation style. This is useful from
keyboards or topics where the slash menu isn't readily accessible. Notes:

- Telegram requires the bot's `@username` and matches it case-insensitively
  (Telegram usernames are case-insensitive); the adapter captures the
  username via `getMe()` at startup. If `getMe()` fails, slash commands
  still work, but mention parsing is disabled until the next start.
- Discord ships raw user-id mention tokens (`<@USER_ID>` or the legacy
  `<@!USER_ID>` nickname-alias form) in `message.content` even though the
  client UI renders `@PwrAgent`. The adapter matches on the bot's user_id,
  taken from the configured `applicationId` (which equals the bot user_id
  for any modern Discord app). If `applicationId` is not set, mention
  parsing is disabled.
- The mention parser also runs against attachment captions, so a photo or
  file uploaded with caption `@<bot> resume` dispatches as the `resume`
  command (the typed verb wins over the incidental upload). Bare or
  unrecognized captions still route the attachment as media.

## Button Layout

Interactive actions can carry generic layout hints. Shared workflow code may
request an automatic column count, explicit rows/columns, row breaks before or
after an action, or a full-width action. Providers translate those hints into
the closest native layout they support: Telegram inline keyboards can honor
explicit row groupings, and Discord components use action rows with provider
limits.

## Workspace Handoff

A bound conversation can move the current thread between Local and Worktree
from `/status` when PwrAgent has enough repository and Git branch metadata for a
safe handoff. The status card shows a `Handoff` action only for eligible
threads.

The handoff mode shows the project repository path, the current working
directory path, the workspace kind, and the current branch before asking for a
choice. Local-to-worktree handoff asks which branch should remain checked out
in Local, then asks for confirmation. Worktree-to-local handoff asks for
confirmation directly. Both paths call the desktop workspace handoff operation,
then refresh the binding display and status card after success.

All handoff steps include text fallback, so replying with the shown number,
label, `confirm`, `back`, `refresh`, or `cancel` follows the same controller
path as pressing a button. `/resume` still starts or binds threads; the New
Local / New Handoff split and any low-button-count variation policy are
deferred.

## Typing Indicators

Messaging adapters show platform typing indicators while a bound turn is
actively waiting on the agent. Intermediate assistant messages or status updates
do not stop typing by themselves; the indicator stops when the turn completes,
fails, is interrupted, or enters a pending user-input break such as a Plan
questionnaire or approval prompt. After the user answers that prompt, typing can
resume for the same turn until terminal completion.

## Streaming Responses

Telegram and Discord can optionally show live assistant response text while
backend `item/agentMessage/delta` events are arriving. The controller emits a
generic stream update intent with accumulated assistant text; each provider then
renders it only when that provider's streaming setting is enabled. When
streaming is disabled or an update exceeds a safe platform edit limit, the
provider discards the stream update and waits for the normal final assistant
message.

Streaming is separate from typing indicators and tool update notifications.
Typing still reflects turn lifecycle, and the completed assistant message
remains authoritative. Stream surfaces are transient runtime state and are not
persisted as restart-safe managed messages.

## Tool Update Verbosity

PwrAgent can send generated tool-use progress messages to bound conversations.
These messages are not assistant-authored responses. They summarize completed
tool activity with title-only text such as command names, MCP tool names, web
searches, and edited file names. Raw command output, diffs, and tool arguments
that look secret are intentionally excluded.

Generated update quality depends on backend tool metadata. Codex
`commandActions` and Grok `dynamicToolCall` path/query arguments are normalized
into concise labels such as `Read <file>`, `Listed <directory>`, and
`Searched <directory>` without forwarding raw argument objects.

The app-level default lives in Settings > Messaging as `Tool usage
notifications`. Existing configs default to `Show Some`. A bound conversation
can override the default from its status card with the `Tools: <mode>` action,
which cycles:

| Mode | Behavior |
| --- | --- |
| `Show None` | Suppress generated tool update messages. |
| `Show Less` | Batch all completed tool updates, flushing every 60 seconds and at turn boundaries. |
| `Show Some` | Default. Send up to three quiet updates individually, then batch every 30 seconds. |
| `Show More` | Send up to five quiet updates individually, then batch every 15 seconds. |
| `Show All` | Send each completed tool update individually. |

Effective mode is resolved as binding override, then Settings > Messaging
default, then `Show Some` for old state. Pending batches flush before assistant
messages, approval or questionnaire prompts, status replies, and terminal turn
status so tool progress does not arrive after the response it explains.

## Attachments

Bound, authorized conversations can send supported attachments into the active
thread. PwrAgent accepts bounded text-like files (`.txt`, `.md`, `.csv`, `.json`,
`.jsonl`, `.toml`, `.yaml`, `.yml`, logs, and similar UTF-8 text), images, GIFs
as still images for model input, and PDFs when bounded text can be extracted.
Unsupported binaries, audio/video, archives, OCR-only PDFs, and oversized files
are rejected with a short provider message instead of being forwarded to a model.

Images use the shared upload profile setting. The default `medium` profile
matches desktop paste behavior; `low`, `high`, and `actual` can be set through
TOML or environment variables while still respecting hard safety caps.

## Turn Admission

Ordinary bound text and media are admitted by desktop messaging core, not by
individual providers. PwrAgnt waits briefly before starting a turn so clients
that split long text, code blocks, images, or files can deliver the rest of the
input. The default wait is 500 ms. Commands, callbacks, approval replies,
questionnaire replies, and `/resume` navigation bypass this wait.

If a follow-up message arrives while the bound thread already has an active
turn, PwrAgnt acknowledges it with a quoted preview, keeps the prepared input
in an in-memory queue, and offers `Steer` and `Cancel` where steering is
available. `Steer` sends the queued input into the current turn. `Cancel` drops
it. If the active turn completes first, queued entries are submitted FIFO as
new turns and their old action buttons are removed best-effort.

Attachments are processed before queueing so provider download handles do not
need to survive until the active turn finishes. Downloaded bytes, normalized
image data URLs, and extracted text-file content stay in memory only and are
not written to `messaging-state.json`.

## Configuration

Messaging is disabled unless a channel has both credentials and authorized actor
IDs. Use stable platform user IDs, not usernames, display names, or guild
nicknames.

For local development, the preferred path is:

- `pnpm dev:op`

That command reads one 1Password item and maps fields onto the environment
variables below before launching `pnpm dev`.

To run a second development app instance without connecting any messaging bots,
use:

- `pnpm dev:no-messaging`

This disables messaging only for that app process. It does not rewrite the
settings file or remove stored bot credentials. The Settings > Messaging screen
shows when this runtime override is active.

Default 1Password item:

- Vault: `Private`
- Item: `PwrAgent Messaging`

Override those defaults when needed:

- `PWRAGNT_OP_VAULT`
- `PWRAGNT_OP_ITEM`

Telegram:

- `PWRAGNT_MESSAGING_TELEGRAM_BOT_TOKEN`
- `PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS`
- `PWRAGNT_MESSAGING_TELEGRAM_STREAMING_RESPONSES`

Discord:

- `PWRAGNT_MESSAGING_DISCORD_BOT_TOKEN`
- `PWRAGNT_MESSAGING_DISCORD_APPLICATION_ID`
- `PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS`
- `PWRAGNT_MESSAGING_DISCORD_STREAMING_RESPONSES`

Attachment policy:

- `PWRAGNT_MESSAGING_INPUT_DEBOUNCE_MS`
- `PWRAGNT_MESSAGING_ATTACHMENT_IMAGE_PROFILE` (`low`, `medium`, `high`, or `actual`)
- `PWRAGNT_MESSAGING_ATTACHMENT_MAX_BYTES`
- `PWRAGNT_MESSAGING_ATTACHMENT_MAX_COUNT`

The debounce setting can also be written as `input_debounce_ms` under
`[messaging]` in the desktop config TOML. Use `0` to disable the pre-start wait
while keeping active-turn queueing enabled.

The authorized ID variables are comma-separated lists. Bot tokens are redacted
from runtime logs. Telegram also accepts `TELEGRAM_BOT_TOKEN` and Discord also
accepts `DISCORD_BOT_TOKEN` as local migration fallbacks.

The TOML equivalents are `streaming_responses = true` under
`[messaging.telegram]` or `[messaging.discord]`. Both providers default to
`false`; the Settings > Messaging toggles and environment overrides expose the
same booleans.

Discord slash commands are reconciled on adapter startup when an Application ID
is configured. The reconciler reads existing commands and only creates, patches,
or deletes the commands whose definitions differ; it does not bulk overwrite
commands on every startup.

## Security Model

- Authorization is by immutable platform user ID.
- Usernames, display names, and guild nicknames are metadata only.
- A conversation must be bound to a thread before ordinary text is routed.
- Bindings, pending intents, and delivery records live in
  `messaging-state.json` under the desktop state root.
- Inbound attachments are downloaded only after authorization and active binding
  checks, then capped, sniffed, normalized, or rejected before model upload.
- Telegram callback data and Discord component IDs contain short opaque handles,
  not thread IDs, request payloads, tokens, or callback secrets.
- Discord deliveries use defensive `allowed_mentions` so agent output does not
  ping everyone, roles, or arbitrary users.
- `/status` controls are authorization-gated the same way as `/resume` and free-form text.

Use `/detach` to revoke the active binding for a conversation. If state becomes
corrupt during development, stop the app and remove the relevant binding from
the state-root `messaging-state.json`.

## Manual Smoke Checklist

Run the desktop app with the desired environment variables configured.

Telegram:

1. Start PwrAgent with `pnpm dev:op`; if the bot has a webhook configured, PwrAgent clears it before long polling.
2. Confirm `/resume`, `/threads`, `/status`, `/detach`, and `/bind` are registered in the Telegram command menu.
3. Send `/resume` from an allowlisted Telegram user.
   - Repeat using a text mention (`@` + your bot's username + ` resume`) instead of the slash command — the same thread picker should render. Confirm a bare mention with no verb is treated as plain text and not as a command.
4. Use Projects, select a project, then select a thread.
5. Verify a pinned status card appears and updates in place.
6. Use status buttons to change Model, Reasoning, Fast mode, and Permissions.
7. For a bound Local thread with handoff branch metadata, choose Handoff from
   `/status`, hand off to a new worktree, and verify the refreshed status shows
   the worktree path.
8. For a bound worktree thread, choose Handoff from `/status`, hand off to
   Local, and verify the refreshed status no longer shows a worktree path.
9. Repeat at least one handoff step by text fallback, such as replying `1` or
   `confirm`.
10. Try a stale or ineligible handoff prompt and verify the bot reports a
   recoverable error without detaching the conversation.
11. Send free-form text and verify a PwrAgent turn starts in the bound thread.
12. Verify typing continues through an intermediate assistant update and stops at turn completion.
13. With streaming disabled, trigger a long response and verify no live response message is created or edited before the final answer appears once.
14. Enable Streaming Responses, trigger a long response, and verify Telegram creates then edits one in-progress response before the final answer appears once.
15. Run a quiet command sequence and verify `Show Some` sends individual tool updates.
16. Run a noisy command or file-read sequence and verify remaining tool updates batch before the final assistant response.
17. Cycle Tools through `Show All`, `Show Less`, and `Show None`; verify all, batched, and suppressed behavior respectively.
18. Trigger a Plan questionnaire and answer with both a button and text fallback.
19. Trigger an approval request and test accept, session accept, decline, and cancel with both buttons and text.
20. Verify markdown, inline code, fenced code, long responses, and image output render.
21. Restart PwrAgent and verify the same Telegram conversation still routes to the bound thread.
22. Send `/detach` and verify the status card is unpinned and free-form text asks for `/resume`.
23. Send a small `.txt` attachment and verify a turn starts with the extracted text.
24. Send an image attachment and verify a turn starts with normalized image input.
25. Send an oversized file or voice message and verify it is rejected without model upload.
26. Verify assistant image and file parts render as Telegram photo/document attachments.
27. Send a long or split code-block request as two quick messages and verify only one turn starts.
28. Send a text attachment and a follow-up text message inside the debounce window and verify one turn starts with both inputs.
29. While a turn is active, send a follow-up message and verify the queued notice shows a quoted preview plus Steer and Cancel controls.
30. Click Steer and verify the follow-up is sent into the active turn and the queued controls disappear.
31. Repeat with Cancel and verify the queued input is not submitted after the active turn completes.
32. Repeat without clicking either action and verify completion starts the queued input as the next turn.

Discord:

1. In the Discord Developer Portal, confirm the bot has Gateway access, the privileged Message Content Intent enabled, and the bot was installed with the `applications.commands` scope.
2. Send `/resume` from an allowlisted Discord user.
   - Repeat using a text mention (type `@` and pick the bot from the autocomplete, then ` resume`) instead of the slash command — the same thread picker should render. Confirm a bare mention with no verb is treated as plain text and not as a command. Mention parsing requires `applicationId` to be configured.
3. Verify a numbered thread picker appears with components.
4. Choose a thread by component, then repeat by replying `1`.
5. For a bound Local thread with handoff branch metadata, choose Handoff from
   `/status`, hand off to a new worktree, and verify the refreshed status shows
   the worktree path.
6. For a bound worktree thread, choose Handoff from `/status`, hand off to
   Local, and verify the refreshed status no longer shows a worktree path.
7. Repeat at least one handoff step by text fallback, such as replying `1` or
   `confirm`.
8. Try a stale or ineligible handoff prompt and verify the bot reports a
   recoverable error without detaching the conversation.
9. Send free-form text and verify a PwrAgent turn starts in the bound thread.
10. Verify typing continues through an intermediate assistant update and stops at turn completion.
11. With streaming disabled, trigger a long response and verify no live response message is created or edited before the final answer appears once.
12. Enable Streaming Responses, trigger a long response, and verify Discord creates then edits one in-progress response before the final answer appears once.
13. Run quiet and noisy tool sequences and verify the selected Tools mode controls individual, batched, or suppressed generated updates.
14. Trigger a Plan questionnaire and answer with both a component and text fallback.
15. Trigger an approval request and test accept, session accept, decline, and cancel.
16. Verify markdown, inline code, fenced code, long responses, and image output render.
17. Restart PwrAgent and verify the same Discord channel still routes to the bound thread.
18. Send a small `.txt` attachment and verify a turn starts with the extracted text.
19. Send an image attachment and verify a turn starts with normalized image input.
20. Send an oversized attachment and verify it is rejected without model upload.
21. Verify assistant image and file parts render as Discord embeds/uploads.
22. Send a long or split code-block request as two quick messages and verify only one turn starts.
23. Send a text attachment and a follow-up text message inside the debounce window and verify one turn starts with both inputs.
24. While a turn is active, send a follow-up message and verify the queued notice shows a quoted preview plus Steer and Cancel controls.
25. Click Steer and verify the follow-up is sent into the active turn and the queued controls disappear.
26. Repeat with Cancel and verify the queued input is not submitted after the active turn completes.
27. Repeat without clicking either action and verify completion starts the queued input as the next turn.

Discord currently has parity for the shared workflow and button actions, but it
does not pin or edit status cards yet; status updates degrade to normal
messages until those adapter capabilities are added.

## Chat SDK Decision

Vercel Chat SDK is not the runtime boundary for this MVP. The current direction
is a PwrAgent-owned semantic surface with direct adapters because markdown,
image/media behavior, callback limits, and voice-friendly text fallback are core
requirements. Chat SDK can be reconsidered later as an adapter implementation
detail if it matures without changing PwrAgent workflow logic.

## Related Docs

- [Messaging Adapter Contract](messaging-adapter-contract.md)
- [Messaging Requirements](brainstorms/2026-04-30-messaging-platform-integration-requirements.md)
- [Implementation Plan](plans/2026-04-30-001-feat-messaging-platform-integration-plan.md)
