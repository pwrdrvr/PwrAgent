# Messaging Platform Integration

PwrAgnt can run messaging adapters from the Electron main process so an
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
restart or reopen the bot menu after starting PwrAgnt.

## Button Layout

Interactive actions can carry generic layout hints. Shared workflow code may
request an automatic column count, explicit rows/columns, row breaks before or
after an action, or a full-width action. Providers translate those hints into
the closest native layout they support: Telegram inline keyboards can honor
explicit row groupings, and Discord components use action rows with provider
limits.

## Typing Indicators

Messaging adapters show platform typing indicators while a bound turn is
actively waiting on the agent. Intermediate assistant messages or status updates
do not stop typing by themselves; the indicator stops when the turn completes,
fails, is interrupted, or enters a pending user-input break such as a Plan
questionnaire or approval prompt. After the user answers that prompt, typing can
resume for the same turn until terminal completion.

## Tool Update Verbosity

PwrAgnt can send generated tool-use progress messages to bound conversations.
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
thread. PwrAgnt accepts bounded text-like files (`.txt`, `.md`, `.csv`, `.json`,
`.jsonl`, `.toml`, `.yaml`, `.yml`, logs, and similar UTF-8 text), images, GIFs
as still images for model input, and PDFs when bounded text can be extracted.
Unsupported binaries, audio/video, archives, OCR-only PDFs, and oversized files
are rejected with a short provider message instead of being forwarded to a model.

Images use the shared upload profile setting. The default `medium` profile
matches desktop paste behavior; `low`, `high`, and `actual` can be set through
TOML or environment variables while still respecting hard safety caps.

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
- Item: `PwrAgnt Messaging`

Override those defaults when needed:

- `PWRAGNT_OP_VAULT`
- `PWRAGNT_OP_ITEM`

Telegram:

- `PWRAGNT_MESSAGING_TELEGRAM_BOT_TOKEN`
- `PWRAGNT_MESSAGING_TELEGRAM_AUTHORIZED_USER_IDS`

Discord:

- `PWRAGNT_MESSAGING_DISCORD_BOT_TOKEN`
- `PWRAGNT_MESSAGING_DISCORD_APPLICATION_ID`
- `PWRAGNT_MESSAGING_DISCORD_AUTHORIZED_USER_IDS`

Attachment policy:

- `PWRAGNT_MESSAGING_ATTACHMENT_IMAGE_PROFILE` (`low`, `medium`, `high`, or `actual`)
- `PWRAGNT_MESSAGING_ATTACHMENT_MAX_BYTES`
- `PWRAGNT_MESSAGING_ATTACHMENT_MAX_COUNT`

The authorized ID variables are comma-separated lists. Bot tokens are redacted
from runtime logs. Telegram also accepts `TELEGRAM_BOT_TOKEN` and Discord also
accepts `DISCORD_BOT_TOKEN` as local migration fallbacks.

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

1. Start PwrAgnt with `pnpm dev:op`; if the bot has a webhook configured, PwrAgnt clears it before long polling.
2. Confirm `/resume`, `/threads`, `/status`, `/detach`, and `/bind` are registered in the Telegram command menu.
3. Send `/resume` from an allowlisted Telegram user.
4. Use Projects, select a project, then select a thread.
5. Verify a pinned status card appears and updates in place.
6. Use status buttons to change Model, Reasoning, Fast mode, and Permissions.
7. Send free-form text and verify a PwrAgnt turn starts in the bound thread.
8. Verify typing continues through an intermediate assistant update and stops at turn completion.
9. Run a quiet command sequence and verify `Show Some` sends individual tool updates.
10. Run a noisy command or file-read sequence and verify remaining tool updates batch before the final assistant response.
11. Cycle Tools through `Show All`, `Show Less`, and `Show None`; verify all, batched, and suppressed behavior respectively.
12. Trigger a Plan questionnaire and answer with both a button and text fallback.
13. Trigger an approval request and test accept, session accept, decline, and cancel with both buttons and text.
14. Verify markdown, inline code, fenced code, long responses, and image output render.
15. Restart PwrAgnt and verify the same Telegram conversation still routes to the bound thread.
16. Send `/detach` and verify the status card is unpinned and free-form text asks for `/resume`.
17. Send a small `.txt` attachment and verify a turn starts with the extracted text.
18. Send an image attachment and verify a turn starts with normalized image input.
19. Send an oversized file or voice message and verify it is rejected without model upload.
20. Verify assistant image and file parts render as Telegram photo/document attachments.

Discord:

1. In the Discord Developer Portal, confirm the bot has Gateway access, the privileged Message Content Intent enabled, and the bot was installed with the `applications.commands` scope.
2. Send `/resume` from an allowlisted Discord user.
3. Verify a numbered thread picker appears with components.
4. Choose a thread by component, then repeat by replying `1`.
5. Send free-form text and verify a PwrAgnt turn starts in the bound thread.
6. Verify typing continues through an intermediate assistant update and stops at turn completion.
7. Run quiet and noisy tool sequences and verify the selected Tools mode controls individual, batched, or suppressed generated updates.
8. Trigger a Plan questionnaire and answer with both a component and text fallback.
9. Trigger an approval request and test accept, session accept, decline, and cancel.
10. Verify markdown, inline code, fenced code, long responses, and image output render.
11. Restart PwrAgnt and verify the same Discord channel still routes to the bound thread.
12. Send a small `.txt` attachment and verify a turn starts with the extracted text.
13. Send an image attachment and verify a turn starts with normalized image input.
14. Send an oversized attachment and verify it is rejected without model upload.
15. Verify assistant image and file parts render as Discord embeds/uploads.

Discord currently has parity for the shared workflow and button actions, but it
does not pin or edit status cards yet; status updates degrade to normal
messages until those adapter capabilities are added.

## Chat SDK Decision

Vercel Chat SDK is not the runtime boundary for this MVP. The current direction
is a PwrAgnt-owned semantic surface with direct adapters because markdown,
image/media behavior, callback limits, and voice-friendly text fallback are core
requirements. Chat SDK can be reconsidered later as an adapter implementation
detail if it matures without changing PwrAgnt workflow logic.

## Related Docs

- [Messaging Adapter Contract](messaging-adapter-contract.md)
- [Messaging Requirements](brainstorms/2026-04-30-messaging-platform-integration-requirements.md)
- [Implementation Plan](plans/2026-04-30-001-feat-messaging-platform-integration-plan.md)
