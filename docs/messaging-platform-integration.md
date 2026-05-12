# Messaging Platform Integration Operator Guide

PwrAgent can run messaging adapters from the Electron main process so an
allowlisted Telegram, Discord, Mattermost, Slack, Feishu/Lark, or LINE user can
choose a thread, bind the current conversation, and send free-form text into that thread. The
workflow logic is shared; the providers only own transport, formatting,
callback handles, and platform limits.

This document is the operator/admin setup guide. It intentionally includes
per-provider configuration, permissions, callback URLs, and smoke-test notes.
The contributor guide for implementing a new adapter is
[`docs/messaging-adding-a-provider.md`](messaging-adding-a-provider.md). Provider
packages may also keep rough setup notes next to the adapter when a platform's
console behavior is still being validated.

## Commands

The supported command surface is:

- `/resume` opens the recents browser, with Projects and New-thread navigation.
- `/new` opens the new-thread project browser directly.
- `/status` refreshes the pinned binding/status card.
- `/detach` detaches the conversation and unpins the status card where the platform supports it.
- `/monitor` posts a monitor card for recent PwrAgent threads.
- `/help` shows the canonical command menu.

Telegram registers its native command menu at startup with `setMyCommands`.
Telegram clients can cache command menus, so if old OpenClaw commands still
appear, restart or reopen the bot menu after starting PwrAgent.

### `@<bot>` and `@<bot> <verb>` text-mention alternatives

On Telegram, Discord, Mattermost, and Slack, a bare leading mention shows help.
The same verbs can also be invoked by mentioning the bot followed by the verb —
for example `@PwrAgent resume`, `@PwrAgent new`, or `@PwrAgent help`. The mention
path is recognized before the slash-prefix path and dispatches the identical
`MessagingInboundCommandEvent` the slash form produces, so workflow behavior is
the same regardless of invocation style. This is useful from keyboards or topics
where the slash menu isn't readily accessible. Notes:

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
explicit row groupings, Discord components use action rows with provider
limits, and Feishu/Lark renders actions as interactive-card button modules.

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

Streaming Responses are advanced. They optionally show live assistant response
text while backend `item/agentMessage/delta` events are arriving. The controller
emits a generic stream update intent with accumulated assistant text; each
provider renders it only when the effective streaming policy allows it. When
streaming is disabled, slow mode is active, or an update exceeds a safe platform
edit limit, the provider discards the stream update and waits for the normal
final assistant message.

Streaming is separate from typing indicators and tool update notifications.
Typing still reflects turn lifecycle, and the completed assistant message
remains authoritative. Streaming does not make a turn finish sooner; it edits
the same provider message repeatedly. Those edits can consume provider write
budget quickly and can break voice-reader workflows that announce messages when
received but do not observe later edits. Stream surfaces are transient runtime
state and are not persisted as restart-safe managed messages.

Effective streaming mode is resolved per binding first, then provider setting:

| Mode | Behavior |
| --- | --- |
| `Default` | Follow the provider-level Streaming Responses toggle. |
| `Off` | Suppress stream updates for this binding. |
| `On` | Enable stream updates for this binding even when the provider toggle is off. |

Use the status card's `Stream: <mode>` action, or reply `stream` when actions
are not available, to cycle a binding through `Default` -> `On` -> `Off`.

## Skills Browser

Bound conversations can stage a Codex skill from the status card. Choose
`Skills` to open a paged browser, use `Search` to make the next free-text reply
the skill query, then choose a skill from the results. PwrAgent posts a
confirmation with the full `$skill` name and available metadata such as
description, workspace, enabled status, and skill path.

Selecting a skill does not start a turn. The selected skill is stored on the
messaging binding and is prepended once to the next real user request, including
requests that queue behind an active turn. Commands, browser navigation,
callbacks, and skill-search replies do not consume it. Use `Remove` on the
selection confirmation to clear the staged skill before sending the request.

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

PwrAgent uses two related but distinct protection states:

- **Slow Mode** is our local budget-protection state. It begins when a
  provider-defined scope is close to or at its configured write budget. Slow
  Mode preserves final assistant messages and interactive prompts, but may drop
  non-final streaming edits, routine status-card edits, and intermediate tool
  updates instead of queueing stale noise.
- Typing/activity signals are best-effort presence hints. They do not consume
  the local message/write budget, and they are dropped while a scope is already
  in Slow Mode so they cannot crowd out final turn output.
- **Cool Off** is provider-imposed. It begins when a provider returns
  rate-limit feedback with a retry window. PwrAgent stops sending to that scope
  until the retry window clears, then resumes conservatively.

The messaging status dot turns orange while Slow Mode, Cool Off, or reconnect
degradation is active. Message edits should not be treated as free capacity:
Slack documents `chat.update` as a separately rate-limited Web API method,
Discord and Mattermost rate-limit API requests/routes, and Telegram documents
edit calls as Bot API requests while its public send-message limits do not
guarantee edits are exempt.

Observed edit-rate behavior from May 9, 2026 probes:

| Platform / surface | Probe | Result | Operational guidance |
| --- | --- | --- | --- |
| Telegram supergroup | One new bot message, then one edit per second in the same PwrDrvr supergroup. | 19 edits succeeded; edit 20 returned 429 with `retry_after=36`. | Treat sends and edits as consuming the same practical supergroup write budget. Telegram is the tightest provider for active agent turns. |
| Telegram two-supergroup fan-out | Same pattern run concurrently in the PwrDrvr and GifGrid supergroups. | Each supergroup accepted one message plus 19 edits without a shared bot-wide 20/minute ceiling. | Active PwrAgent threads should usually be bound to separate Telegram supergroups. |
| Telegram two-topic fan-out | Same pattern run concurrently in PwrDrvr topics `5642` and `3509`. | Two sends plus 9 edits on each topic succeeded; edit 10 returned 429 with `retry_after=35`. | Topics share the parent supergroup budget. Do not bind multiple active high-volume threads to different topics in one supergroup expecting isolation. |
| Slack DM | One new bot message in the existing `hhunt` DM, then 60 edits at one edit per second. | Passed without a 429. | Slack edits are more permissive than Telegram in this DM, but new messages should still be budgeted conservatively because `chat.postMessage` has its own special limits. |
| Discord DM and guild channel | One new bot message in the `huntharo2` DM and one in `huntharo-claw / #general`, then 60 edits at one edit per second on both messages. | Passed without a 429. Discord returned an edit bucket of 5 requests / 1 second. | Discord edits are much less restrictive than Telegram, but still count as REST requests and can hit route/global buckets. |
| Mattermost | Not probed as a provider-global claim. | Rate limits are server-configured. | Use the target Mattermost server's `RateLimitSettings` rather than assuming a public SaaS limit. |

Telegram-specific binding guidance:

- Treat Telegram sends and edits as consuming the same practical supergroup
  write budget.
- Active PwrAgent threads should usually be bound to separate Telegram
  supergroups. Binding multiple active threads to topics in the same supergroup
  is likely to exhaust that supergroup's budget, trigger PwrAgent Slow Mode,
  and drop routine updates.
- Topics share the parent supergroup budget.

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

Messaging starts a channel once its required credentials are configured. Use
stable platform user IDs, not usernames, display names, or guild nicknames, for
authorization. An empty authorized-user list is a discovery state: the adapter
connects, inbound messages are discarded, and actionable rejected messages are
logged in Messaging Activity so the operator can copy the stable actor ID into
settings.

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

Normal `pnpm dev` launches are protected by a profile-scoped messaging lease:
only one live app instance for a profile starts messaging adapters. A second
instance stays usable for desktop work and leaves messaging stopped until the
holder exits or its heartbeat expires. Keep `dev:no-messaging` for work where
the current process should never attempt messaging, even if the lease is free.

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

Feishu / Lark:

- `PWRAGENT_MESSAGING_FEISHU_APP_ID`
- `PWRAGENT_MESSAGING_FEISHU_APP_SECRET`
- `PWRAGENT_MESSAGING_FEISHU_INBOUND_MODE` (`persistent` or `webhook`, defaults to `persistent`)
- `PWRAGENT_MESSAGING_FEISHU_TENANT_REGION` (`feishu` or `lark`)
- `PWRAGENT_MESSAGING_FEISHU_TENANT_URL`
- `PWRAGENT_MESSAGING_FEISHU_CALLBACK_BASE_URL`
- `PWRAGENT_MESSAGING_FEISHU_VERIFICATION_TOKEN`
- `PWRAGENT_MESSAGING_FEISHU_ENCRYPT_KEY`
- `PWRAGENT_MESSAGING_FEISHU_AUTHORIZED_USER_IDS`
- `PWRAGENT_MESSAGING_FEISHU_AUTHORIZED_CHATS`
- `PWRAGENT_MESSAGING_FEISHU_AUTHORIZED_TENANTS`
- `PWRAGENT_MESSAGING_FEISHU_SLASH_COMMAND_PREFIX`
- `PWRAGENT_MESSAGING_FEISHU_REGISTER_SLASH_COMMANDS`
- `PWRAGENT_MESSAGING_FEISHU_STREAMING_RESPONSES`

LINE:

- `PWRAGENT_MESSAGING_LINE_CHANNEL_ACCESS_TOKEN`
- `PWRAGENT_MESSAGING_LINE_CHANNEL_SECRET`
- `PWRAGENT_MESSAGING_LINE_WEBHOOK_URL`
- `PWRAGENT_MESSAGING_LINE_CALLBACK_BASE_URL`
- `PWRAGENT_MESSAGING_LINE_BOT_USER_ID`
- `PWRAGENT_MESSAGING_LINE_AUTHORIZED_USER_IDS`
- `PWRAGENT_MESSAGING_LINE_AUTHORIZED_GROUPS`
- `PWRAGENT_MESSAGING_LINE_AUTHORIZED_ROOMS`
- `PWRAGENT_MESSAGING_LINE_STREAMING_RESPONSES`

Attachment policy:

- `PWRAGNT_MESSAGING_INPUT_DEBOUNCE_MS`
- `PWRAGNT_MESSAGING_ATTACHMENT_IMAGE_PROFILE` (`low`, `medium`, `high`, or `actual`)
- `PWRAGNT_MESSAGING_ATTACHMENT_MAX_BYTES`
- `PWRAGNT_MESSAGING_ATTACHMENT_MAX_COUNT`

The debounce setting can also be written as `input_debounce_ms` under
`[messaging]` in the desktop config TOML. Use `0` to disable the pre-start wait
while keeping active-turn queueing enabled.

The authorized ID variables are comma-separated lists and may be empty during
first-run discovery. Bot tokens are redacted from runtime logs. Telegram also
accepts `TELEGRAM_BOT_TOKEN` and Discord also accepts `DISCORD_BOT_TOKEN` as
local migration fallbacks.

The TOML equivalents are `streaming_responses = true` under a provider section,
for example `[messaging.telegram]`, `[messaging.discord]`,
`[messaging.mattermost]`, `[messaging.slack]`, `[messaging.feishu]`, or
`[messaging.line]`. Providers default to `false`; the Settings > Messaging
toggles and environment overrides expose the same booleans. Binding-level
`Stream: On` can opt a single binding into streaming without changing the
provider default.

Feishu / Lark also accepts `inbound_mode = "persistent"` or
`inbound_mode = "webhook"` under `[messaging.feishu]`. Persistent connection is
the default.

## Feishu / Lark setup

Feishu and Lark share the same Open Platform protocol. PwrAgent uses `feishu`
as the code identifier and exposes the region choice in Settings: `Feishu`
defaults to `https://open.feishu.cn`, while `Lark` defaults to
`https://open.larksuite.com`.

1. Create a Feishu / Lark custom app in the Open Platform console and enable
   the Bot capability.
2. In PwrAgent Settings > Messaging > Feishu / Lark, store the App ID and App
   Secret in Keychain. The connection test mints a tenant access token and
   calls the low-permission bot info endpoint (`/open-apis/bot/v3/info`).
3. In the Open Platform **Event Configuration** tab, use **Receive events
   through persistent connection**. This is PwrAgent's default and recommended
   mode: the desktop app opens an outbound SDK WebSocket to Lark, so operators
   do not need to expose a localhost listener through Cloudflare Tunnel, ngrok,
   or a public reverse proxy that can then be fuzzed by internet scanners.
4. In **Event Configuration**, subscribe the events PwrAgent consumes:
   - Required: `im.message.receive_v1` so PwrAgent receives direct messages and
     group mentions.
   - Optional/noisy: `im.chat.access_event.bot_p2p_chat_entered_v1`. Lark emits
     it when a user opens or enters a bot DM; PwrAgent ignores it because it is
     not a user command, but registering it avoids noisy "no handler" SDK logs
     if the event is enabled.
   - Not currently consumed: `im.chat.member.bot.added_v1`,
     `im.chat.member.bot.deleted_v1`, `im.message.message_read_v1`,
     `im.message.reaction.created_v1`, `im.message.reaction.deleted_v1`, and
     `im.message.updated_v1`. They can be useful later for diagnostics,
     membership tracking, read receipts, reactions, or edited-message handling,
     but they are not required for the current adapter.
5. In the Open Platform **Callback Configuration** tab, also use **Receive
   callbacks through persistent connection** and add `card.action.trigger`.
   This callback is what Lark sends when a user clicks an interactive-card
   button such as `Resume`. If message events work but clicking a card button
   shows Lark client error `200340` and PwrAgent logs no
   `eventType=card.action.trigger` event, this callback configuration is not
   reaching PwrAgent yet.
6. Grant and publish the app version with the messaging permissions used by
   those events and bot replies. Useful Lark/Feishu console scopes for the
   current adapter are:
   - Required for group mentions: `im:message.group_at_msg:readonly` ("Receive
     users' mentions"). `im:message.group_at_msg.include_bot:readonly` is
     broader and only needed if you want events for mentions sent by other bots
     too.
   - Required: `im:message:send_as_bot` ("Send messages as an app") so PwrAgent
     can reply and post status cards.
   - Recommended: `im:message:readonly` ("Read direct messages and group chat
     messages") because the message receive event, related Lark console wiring,
     and image/file resource downloads reference it.
   - Recommended: `im:message:update` ("Update message") so PwrAgent can refresh
     or dismiss status cards instead of posting duplicates.
   - Recommended for shared chats: `im:chat:readonly` ("Obtain group
     information") so group membership events and chat metadata are available
     when you allowlist group conversations.
   - Broad shortcut: `im:message` ("Read and send direct messages and group chat
     messages") covers multiple message read/send capabilities. It is fine for
     a private internal app, but the narrower scopes above are easier to reason
     about when Lark asks for approval.
   New bot profile changes, event subscriptions, and permission scopes do not
   take effect for a workspace until you create and publish a version of the
   internal app.
7. Use webhook mode only as a fallback. If you set
   `PWRAGENT_MESSAGING_FEISHU_INBOUND_MODE=webhook`, configure event
   subscriptions in the Open Platform console to point at your public tunnel,
   forwarding to PwrAgent's local callback listener
   (`http://127.0.0.1:47823` by default).
8. Enable encrypted callbacks in the platform console and store the Encryption
   Key in Keychain. Encryption is recommended for persistent connection and
   webhook modes; PwrAgent decrypts encrypted event envelopes before dispatch.
   Store the Verification Token in Keychain if webhook mode is enabled. Plain
   webhook events are rejected if their token does not match.
9. Add allowlisted Feishu / Lark `open_id` values (`ou_...`). Add chat IDs
   (`oc_...`) or tenant keys for shared conversations; empty shared-surface
   allowlists deny shared chat access.

In Feishu / Lark group chats, PwrAgent's supported path is mention-triggered:
type `@` and select the bot when sending a bound-thread message. Direct
messages do not need the mention. Some tenants expose broader group-message
read permissions, but those permissions are not the default operator path and
may require extra workspace approval.

Inbound Feishu / Lark image and file messages are forwarded to the shared
PwrAgent attachment processor after actor and chat authorization. Audio and
video messages are currently surfaced as unsupported attachments.

Feishu / Lark interactive cards carry only signed opaque callback handles in
button values. The persisted handle record owns the action id, binding id,
allowed actors, and routing state so buttons survive app restarts and fail
closed after expiry. The adapter uses the official Node SDK for persistent
inbound events, but keeps outbound sends on direct Open Platform REST calls so
PwrAgent owns rate-limit retry behavior.

## LINE setup

LINE is webhook-only. Operators must expose PwrAgent's local listener through a
public HTTPS URL and configure that URL in the LINE Developers console.

1. Create or choose a LINE Messaging API channel in the LINE Developers console.
2. Copy the channel secret. PwrAgent can start the local webhook listener with
   only this secret so LINE's webhook verification can pass before a channel
   access token exists.
3. In PwrAgent Settings > Messaging > LINE, store the Channel Secret in
   Keychain. Add the Channel Access Token later once LINE lets you issue it;
   outbound messages and attachment downloads stay disabled until the token is
   configured.
4. Set Local Webhook Listener to the local address cloudflared forwards to,
   normally `http://127.0.0.1:47822`. If the URL has an explicit port, PwrAgent
   binds that port on the URL's host; otherwise it binds `47822`.
5. Configure Webhook URL in the LINE Developers console to the public HTTPS URL
   that forwards to the local listener, for example
   `https://line-webhook.example.com/`. Cloudflare Tunnel, Tailscale Funnel, or
   ngrok all fit this shape.
6. Add allowlisted LINE user IDs (`U` + 32 lowercase hex chars). Add group IDs
   (`C...`) and room IDs (`R...`) when the bot should run in shared chats.
7. Use the Connection test button to call `getBotInfo`; the returned bot user ID
   can be stored for group mention filtering.

Webhook requests are rejected before JSON parsing unless `X-Line-Signature`
matches the HMAC-SHA256 of the raw request body keyed by the channel secret.
LINE does not support bot message edits, so LINE streaming responses should stay
off for v1; final assistant messages are posted as normal LINE messages.

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
- Telegram callback data and Discord component IDs contain compact opaque handles,
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
2. Confirm `/resume`, `/new`, `/status`, `/detach`, `/monitor`, and `/help` are registered in the Telegram command menu.
3. Send `/resume` from an allowlisted Telegram user.
   - Repeat using a text mention (`@` + your bot's username + ` resume`) instead of the slash command — the same thread picker should render. Send a bare mention (`@` + your bot's username) and confirm the help menu renders with Resume and New actions.
   - Send `/new` or tap New from the help menu and confirm the new-thread project picker renders.
4. Use Projects, select a project, then select a thread.
5. Verify a pinned status card appears and updates in place.
6. Use status buttons to change Model, Reasoning, Fast mode, and Permissions.
7. Choose Skills, search for a skill, select it, then send a short request.
   Verify the turn starts with that skill prepended. Repeat once and use Remove
   before sending to verify the staged skill clears.
8. For a bound Local thread with handoff branch metadata, choose Handoff from
   `/status`, hand off to a new worktree, and verify the refreshed status shows
   the worktree path.
9. For a bound worktree thread, choose Handoff from `/status`, hand off to
   Local, and verify the refreshed status no longer shows a worktree path.
10. Repeat at least one handoff step by text fallback, such as replying `1` or
   `confirm`.
11. Try a stale or ineligible handoff prompt and verify the bot reports a
   recoverable error without detaching the conversation.
12. Send free-form text and verify a PwrAgent turn starts in the bound thread.
13. Verify typing continues through an intermediate assistant update and stops at turn completion.
14. With streaming disabled, trigger a long response and verify no live response message is created or edited before the final answer appears once.
15. Enable Streaming Responses, trigger a long response, and verify Telegram creates then edits one in-progress response before the final answer appears once.
16. Run a quiet command sequence and verify `Show Some` sends individual tool updates.
17. Run a noisy command or file-read sequence and verify remaining tool updates batch before the final assistant response.
18. Cycle Tools through `Show All`, `Show Less`, and `Show None`; verify all, batched, and suppressed behavior respectively.
19. Trigger a Plan questionnaire and answer with both a button and text fallback.
20. Trigger an approval request and test accept, session accept, decline, and cancel with both buttons and text.
21. Verify markdown, inline code, fenced code, long responses, and image output render.
22. Restart PwrAgent and verify the same Telegram conversation still routes to the bound thread.
23. Send `/detach` and verify the status card is unpinned and free-form text asks for `/resume`.
24. Send a small `.txt` attachment and verify a turn starts with the extracted text.
25. Send an image attachment and verify a turn starts with normalized image input.
26. Send an oversized file or voice message and verify it is rejected without model upload.
27. Verify assistant image and file parts render as Telegram photo/document attachments.
28. Send a long or split code-block request as two quick messages and verify only one turn starts.
29. Send a text attachment and a follow-up text message inside the debounce window and verify one turn starts with both inputs.
30. While a turn is active, send a follow-up message and verify the queued notice shows a quoted preview plus Steer and Cancel controls.
31. Click Steer and verify the follow-up is sent into the active turn and the queued controls disappear.
32. Repeat with Cancel and verify the queued input is not submitted after the active turn completes.
33. Repeat without clicking either action and verify completion starts the queued input as the next turn.

Discord:

1. In the Discord Developer Portal, confirm the bot has Gateway access, the privileged Message Content Intent enabled, and the bot was installed with the `applications.commands` scope.
2. Send `/resume` from an allowlisted Discord user.
   - Repeat using a text mention (type `@` and pick the bot from the autocomplete, then ` resume`) instead of the slash command — the same thread picker should render. Send a bare bot mention and confirm the help menu renders with Resume and New actions. Mention parsing requires `applicationId` to be configured.
   - Send `/new` or tap New from the help menu and confirm the new-thread project picker renders.
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

## Mattermost Setup

Mattermost is supported as a third provider alongside Telegram and Discord.
Unlike the other two, Mattermost delivers interactive button clicks
**out-of-band** via HTTP POST to a callback URL the bot must host. PwrAgent
binds the callback listener to `127.0.0.1` only; production deployments
front it with a tunnel (Cloudflare Tunnel or Tailscale Funnel) which
terminates TLS and forwards to localhost.

### 1. Create a bot account

In Mattermost: System Console → Integrations → Bot Accounts → Add Bot Account.

- Display name: anything (e.g., `PwrAgent`).
- Permissions: needs to post in target channels, read posts, upload/download
  files, edit its own posts, and update channel headers if you want
  conversation-title updates. **Also grant `manage_slash_commands`** if you
  want PwrAgent to register `/resume`, `/new`, `/status`, `/detach`, and `/help` as native
  Mattermost slash commands with autocomplete (recommended). Without it,
  the adapter will log a permission warning at startup and fall back to
  text-mention parsing (`@pwragent resume`).
- Copy the access token. Either paste it into the desktop Settings UI
  (Settings → Messaging → Mattermost → Bot Token — stored in the system
  keychain via Electron `safeStorage`) or set
  `PWRAGENT_MESSAGING_MATTERMOST_BOT_TOKEN` in the environment. Env vars
  override Settings UI values when both are set; the snapshot flags
  `overriddenByEnv` so the UI surfaces this.

Add the bot to the channels where you want PwrAgent to be addressable.
Without explicit channel membership, Mattermost does not deliver `posted`
events to the bot — outgoing posts will fail with `403`.

Slash commands are scoped per-team in Mattermost. PwrAgent reconciles its
canonical command set (`/resume`, `/new`, `/status`, `/detach`, `/help`) against every team
the bot is a member of on adapter startup — newly-joined teams are picked
up by restarting the adapter (a team-membership webhook listener that
re-reconciles mid-session is a future improvement). Reconciliation is
idempotent and uses the same callback URL as interactive buttons (the
listener routes by Content-Type, so a single tunnel mapping covers both).

### 2. Choose a tunnel for the callback URL

Pick one. Both work; trade-offs differ.

#### Option A — Cloudflare Tunnel + Zero Trust (recommended)

Cloudflare Tunnel runs a `cloudflared` daemon on the PwrAgent host. The
daemon dials out to Cloudflare's edge; Cloudflare publishes a hostname
(`https://pwragent.example.com`) that proxies to `127.0.0.1:<port>` on
your host. No inbound port opening on your network.

Steps:

1. Create a tunnel on `dash.cloudflare.com` → Zero Trust → Networks → Tunnels.
2. Run `cloudflared tunnel run <tunnel-id>` on the PwrAgent host (typically
   as a launchd / systemd service).
3. Configure the public hostname route to forward to
   `http://localhost:47821` (the default bind port — change it by
   embedding a different port in `callbackBaseUrl`, e.g.
   `http://localhost:8000/`, which the adapter parses to derive the
   listener port).

**Recommended hardening (defense in depth on top of PwrAgent's HMAC):**

- **IP allowlist:** restrict the public hostname to Mattermost's outbound IP
  range. Self-hosted Mattermost: the operator's egress IPs. Mattermost
  Cloud: their published egress ranges.
- **Cloudflare Access policies:** add an Access policy on the route so only
  requests from the allowlisted IP range reach `cloudflared`.
- **Custom security header (optional):** configure Mattermost (or a
  Cloudflare Worker / Page Rule) to add a header like
  `X-PwrAgent-Mattermost-Tunnel: <secret>` and verify in the listener.
  Tracked as a follow-up — the in-process HMAC over `(intentId,
  actionId, issuedAt)` already authenticates the payload.

#### Option B — Tailscale Funnel (free-ish)

Tailscale Funnel publishes a `https://<host>.tail<id>.ts.net` URL that
forwards to a localhost port on your tailnet device. Free for personal
use up to a quota.

Steps:

1. Install Tailscale on the PwrAgent host. Sign in.
2. Enable Funnel for the device:
   `tailscale funnel 47821` (forwards `https://<host>.tail<id>.ts.net/`
   to `localhost:47821`).
3. Set `PWRAGENT_MESSAGING_MATTERMOST_CALLBACK_BASE_URL` to that
   `https://<host>.tail<id>.ts.net/` URL.

Funnel does not provide a built-in IP allowlist. Rely on PwrAgent's HMAC
verification (which you'd want anyway) and consider rotating the
generated HMAC secret if you suspect leakage. Restart the adapter
regenerates the secret automatically.

#### Option C — `ngrok` (development only)

`ngrok http 47821` for a quick disposable HTTPS URL. Free tier rotates
the URL each restart. Don't use for production — there's no IP
allowlist and the URL is publicly enumerable. Useful for the live
smoke test in development.

### 3. Configure PwrAgent

Two paths — pick whichever fits your deployment. The settings landed in [PR #199](https://github.com/pwrdrvr/PwrAgent/pull/199); see that PR for the full integration if you're adding a new provider.

**Path A — Desktop Settings UI (recommended for desktop users).** Open Settings → Messaging → Mattermost. Fill in the bot token (Keychain), server URL, callback base URL, callback port, and the optional slash-command toggles. Add authorized user IDs immediately if you already know them. If you do not, leave the list empty, send the bot an actionable message, then open Messaging Activity; PwrAgent discards the unauthorized inbound message and logs the Mattermost user ID there so you can copy it into the allowlist. The `Test` button on the Bot Token row hits `<serverUrl>/api/v4/users/me` with the token to confirm both pieces. Slash commands are off by default — see "Slash command registration" below.

**Path B — Environment variables (headless / CI / Docker).** Set the variables before launching. Env vars override Settings UI values when both are present; the UI surfaces this with a `overriddenByEnv` badge per field.

```bash
PWRAGENT_MESSAGING_MATTERMOST_ENABLED=true
PWRAGENT_MESSAGING_MATTERMOST_BOT_TOKEN=<bot access token>
PWRAGENT_MESSAGING_MATTERMOST_SERVER_URL=https://chat.example.com
PWRAGENT_MESSAGING_MATTERMOST_CALLBACK_BASE_URL=https://pwragent.example.com/messaging/mattermost/callback
PWRAGENT_MESSAGING_MATTERMOST_AUTHORIZED_USER_IDS=<mattermost user id>,<another id>
PWRAGENT_MESSAGING_MATTERMOST_REGISTER_SLASH_COMMANDS=true       # optional; default false
PWRAGENT_MESSAGING_MATTERMOST_SLASH_COMMAND_PREFIX=pwragent_     # optional; default pwragent_
PWRAGENT_MESSAGING_MATTERMOST_CALLBACK_HMAC_SECRET=<hex secret>  # optional; regenerated per-restart if unset
```

The local HTTP listener binds to the port embedded in `CALLBACK_BASE_URL` if one is present (e.g., `http://localhost:47821/` → 47821), otherwise to the default port 47821. There is no separate port setting — the URL is the single source of truth so the bind port and the URL Mattermost dials cannot disagree.

### 3a. Slash command registration

`registerSlashCommands` is **off by default**. Mattermost 10.x and earlier omit `root_id` from the slash-command request body, so a slash response cannot be threaded — it lands in the parent channel even when the user invoked the command from inside a thread. The recommended primary entry point is `@<bot> help` text-mention parsing, which works on every Mattermost version and preserves thread context.

If you operate Mattermost 11.0+ (which adds `root_id` to slash-command bodies) or you accept the v10.x channel-reply tradeoff, opt in via the Settings UI toggle or `PWRAGENT_MESSAGING_MATTERMOST_REGISTER_SLASH_COMMANDS=true`. With the toggle on, PwrAgent reconciles its canonical command set against every team the bot is a member of on adapter startup. The `slashCommandPrefix` field controls the namespace (default `pwragent_` → `/pwragent_resume`, `/pwragent_new`, `/pwragent_status`, `/pwragent_detach`, `/pwragent_help`); set it blank to register bare triggers and accept the collision risk with built-in commands like `/status`, `/away`, `/leave`.

Authorize on stable Mattermost user IDs (UUIDs visible via Settings →
Profile → Account Settings → Display → Username, then
`/api/v4/users/username/<name>` returns the `id`). Mutable usernames
are not authorization-safe.

`PWRAGENT_MESSAGING_MATTERMOST_SLASH_COMMAND_PREFIX` controls the
namespace prepended to every registered slash-command trigger.
Default: `pwragent_`, which gives `/pwragent_resume`, `/pwragent_new`,
`/pwragent_status`, `/pwragent_detach`, `/pwragent_help` — chosen to avoid collisions with built-in
Mattermost commands (`/status`, `/away`, `/leave`). Set to an empty
string to register bare triggers and accept the collision risk.
Allowed chars: `[A-Za-z0-9_./-]`; full trigger length 1–128 chars per
Mattermost server validation. Invalid prefixes are logged and replaced
with the default at startup.

`PWRAGENT_MESSAGING_MATTERMOST_CALLBACK_HMAC_SECRET` is **strongly
recommended** when running with env-var configuration. If unset, the
adapter mints a fresh random secret each time the process starts —
every interactive button rendered in a previous session immediately
fails HMAC verification and silently no-ops on click. Setting an
explicit value pins the keyring across restarts, so existing buttons
continue to work.

Generate a 32-byte random hex string and store it however you store
other secrets (1Password, env file, etc.):

```bash
openssl rand -hex 32
```

Pin the same value across desktop instances if you ever run multiple
clients pointed at the same Mattermost workspace; otherwise each
client's buttons only validate against its own keyring.

### 4. Validate (smoke test checklist)

After the bot is bound, the tunnel is up, and the env vars (including
the pinned HMAC) are loaded, walk this checklist in order. Each step
should succeed before moving to the next:

**Cold-start sanity:**

1. Launch PwrAgent. Look for `mattermost: adapter started successfully`
   and `mattermost callback listener bound port=47821 host=127.0.0.1`
   in the dev console. No `failed to start adapter` warnings.
1a. Confirm slash-command reconciliation: a `mattermost slash commands
   reconciled` log line per team the bot is in, with `tokenCount=3`
   (or however many entries are in `DESIRED_MATTERMOST_COMMANDS`). If
   you see `getMyTeams failed` or per-command `create failed`, the bot
   lacks `manage_slash_commands` — text-mention invocation still works
   but the `/` autocomplete won't appear.

**Slash command UX:**

1b. In any channel the bot belongs to, type `/pwragent` in the
    message composer (or whatever prefix you've configured). The
    namespaced commands (`/pwragent_resume`, `/pwragent_new`,
    `/pwragent_status`, `/pwragent_detach`, `/pwragent_help` by default) should appear in the autocomplete
    menu with their descriptions and hints. Note the namespacing —
    unprefixed `/status` would collide with Mattermost's built-in
    user-status command, which is why we register under a namespace
    by default.
1c. Type `/pwragent_resume` and submit. The bot replies with the
    navigator (thread picker), same as clicking `Resume` on a
    binding prompt.
1c-thread. Send `/pwragent_resume` from inside a channel **thread
    reply**. The picker should render in the same thread (not in
    the parent channel), and the resulting binding should be
    `kind: "thread"` with the channel as `parentTitle` on the chip.

    Implementation note: Mattermost server v10.x (and earlier)
    does NOT include `root_id` in the slash-command webhook body —
    fixed in v11.0+ but not backported. The adapter routes the
    first delivery via Mattermost's `response_url` endpoint, which
    posts our payload with `RootId = args.RootId` server-side
    (Mattermost knows the thread context internally; v10.x just
    didn't propagate it via the webhook body). Subsequent renders
    use `createPost` with the recovered `root_id`. See `mattermost
    response_url outbound` log lines to verify the path fired.

1c-mention. **Recommended for threads on any version**: send
    `@pwragent resume` (or `@pwragent status` / `@pwragent help`)
    from inside a thread reply. Text mentions go through the WS
    `posted` event which always carries full thread context
    (`post.root_id`), so this path works without the response_url
    workaround. On any provider where slash commands are
    namespaced (Mattermost: `/pwragent_*`), text mention is
    typically the more discoverable invocation in threads where
    the slash menu may be cluttered.

1c-help. Send `@pwragent` or `@pwragent help` (or `/pwragent_help`) anywhere the
    bot can see. The bot replies with the canonical command list
    and notes both invocation styles.
1c-new. Send `@pwragent new` (or `/pwragent_new`) anywhere the bot
    can see. The bot replies with the new-thread project picker.
1d. From a separate browser/account that is NOT in
    `PWRAGENT_MESSAGING_MATTERMOST_AUTHORIZED_USER_IDS`, run
    `/pwragent_resume`. The command executes (Mattermost has no
    per-user permission gating on bot commands) but PwrAgent
    rejects the actor and returns the ephemeral text "You are not
    authorized to use this command." — visible only to the invoker.

**DM bind flow:**

2. Open a Direct Message to the bot in Mattermost. Send a naked
   message: `You there?`
3. The bot replies with the canonical command menu, including `Resume`
   and `New` buttons.
4. Click `Resume`. The bot replies with the navigator: a thread picker
   with `Next`, `Projects`, `New`, `Cancel` buttons. The console shows
   `mattermost callback HMAC verification failed` only if the env-var
   HMAC isn't set; if it is, the click round-trips cleanly.
5. Click each navigator button in turn — `Next` advances the page,
   `Projects` switches to projects, `New` starts a fresh thread, and
   `Cancel` dismisses without binding.

**Bind to a thread:**

6. From the picker, select an existing thread. The status card
   appears, pinned to the channel header.
7. The status card shows binding details (model, reasoning, branch,
   directory) and the standard buttons (`Model`, `Reasoning`,
   `Tools`, `Permissions`, `Stop`, `Refresh`, `Detach`).
8. The desktop app's binding chip for that thread now shows the
   Mattermost icon and the DM peer's username (e.g. `harold`).

**Round-trip a turn:**

9. In the same DM, send `Who are you?`
10. The bot enters typing state; the desktop app shows the message
    arriving in the bound thread.
11. The agent responds. The response appears in both the Mattermost
    DM and the desktop app.
12. The status card updates to reflect the completed turn.

**Status surface buttons:**

13. Click `Refresh` on the status card. The card re-renders with
    fresh values; no buttons are stripped.
14. Click `Tools`, then `Permissions`. Each click cycles the value
    and the card updates inline. The desktop app's UI mirrors the
    change (cross-surface state bus).
15. Click `Skills`, use `Search`, pick a skill, and verify the
    confirmation offers `Remove`. Send a request and verify the skill
    is prepended once; repeat with `Remove` and verify the next request
    is not prefixed.

**Detach:**

16. Click `Detach` on the status card. The bot posts `Thread detached`
    and removes the status card's buttons. The desktop app's binding
    chip disappears for that thread.
17. Send another message in the DM. The bot shows the command menu
    again; the offered `Resume` button still works to re-bind.

**Cross-restart persistence (with env-var HMAC pinned):**

18. Quit and relaunch PwrAgent.
19. Click a button on a status card from a still-bound thread that
    was rendered before the restart. The click round-trips and the
    status updates. Without the env-var HMAC pinned, this step fails
    silently — the canary that says "you forgot to set the HMAC env
    var."

**Failure modes (don't block on these — verify they fail cleanly):**

19. Tear down the tunnel temporarily and click a button. The click
    silently fails (no client-visible error in Mattermost; no
    dispatch in PwrAgent). Restore the tunnel.
20. With dev-tools open, send a button click with a tampered
    `integration.context.hmac` value. PwrAgent logs
    `mattermost callback HMAC verification failed` and responds 200
    (no info leak). No dispatch happens.

## Slack Setup

Slack is supported with **Socket Mode** as the v1 inbound transport. PwrAgent
opens an outbound WebSocket to Slack, so desktop users do not need a public
callback URL or tunnel. Slack's Events API / signed HTTP request path is modeled
in settings for a future mode, but the adapter currently starts only in Socket
Mode.

### 1. Create a Slack app

Create one Slack app per PwrAgent desktop bot identity. For a single
user's desktop app, that means one Slack app named for that user or
machine (for example, `PwrAgent - hhunt`). If twenty people each run
their own PwrAgent desktop instance, the safest current deployment is
twenty Slack apps. Do not share one app token / bot token across many
desktop instances unless you intentionally want every instance to
connect as the same bot and risk duplicate event handling.

In Slack's app configuration UI:

1. Create an app for the target workspace.
2. Go to **Socket Mode first**. Turn on **Enable Socket Mode** before opening
   Event Subscriptions or Interactivity & Shortcuts. This order is important:
   if Event Subscriptions or Interactivity is configured first, Slack steers the
   app toward the older POST Request URL flow, which requires a public callback
   endpoint and is not the supported PwrAgent v1 path.
3. In Socket Mode, create an app-level token with the `connections:write` scope.
   A clear token name is `PwrAgent Socket Mode`. Slack app tokens start with
   `xapp-`; this is the value for PwrAgent's App Token field.
4. Add a bot user and install the app to the workspace. Slack bot tokens start
   with `xoxb-`; this is the value for PwrAgent's Bot Token field.
5. After Socket Mode is enabled, open Event Subscriptions, enable events, and
   subscribe the app to message events your deployment needs
   (`message.channels`, `message.groups`, `message.im`, `message.mpim`, and
   `app_mention`). With Socket Mode enabled, Slack should show that no Request
   URL is needed.
6. After Socket Mode is enabled, open Interactivity & Shortcuts and enable
   interactivity for Block Kit button clicks. Again, no public Request URL is
   needed for the Socket Mode path.

Minimum bot scopes for the current adapter shape:

- `chat:write` for outbound messages and updates.
- `channels:history`, `groups:history`, `im:history`, and `mpim:history` for the
  conversation types you allow. These history scopes also let PwrAgent fetch
  the root message for a Slack thread so binding chips can show
  `#channel/root message` instead of a generic `#channel/Thread` label.
- `channels:read`, `groups:read`, `im:read`, and `mpim:read` are optional but
  recommended for conversation labels. Slack events and Block Kit interactions
  do not reliably include channel names, especially for private channels; with
  the matching read scope, PwrAgent can call `conversations.info` and label
  binding chips with the real channel name.
- `files:read` for inbound file downloads.
- `files:write` for outbound file delivery.
- `users:read` is optional but recommended. Slack message events include the
  sender's stable user ID, but not their display name; with `users:read`,
  PwrAgent can call `users.info` and label DM bindings / Messaging Activity with
  the person's Slack profile name. Without it, authorization still works, but
  the UI falls back to user IDs or generic DM labels.
- `commands` only if you configure Slack slash commands for the app. If you do,
  configure `/pwragent_resume`, `/pwragent_new`, `/pwragent_status`, and other
  desired prefixed commands consistently with the PwrAgent command prefix.

### 2. Configure PwrAgent

**Path A — Desktop Settings UI.** Open Settings → Messaging → Slack. Fill in Bot
Token and App Token, then leave Inbound Mode set to Socket Mode. Signing Secret
is optional for Socket Mode, but recommended because PwrAgent uses it as a
stable local secret for Block Kit button payload validation; use the value from
Slack **Basic Information → App Credentials → Signing Secret**. Authorized Slack
user IDs and optional workspace/team IDs can be added immediately if you already
know them. If you do not, leave the authorized user list empty, enable Slack, DM
or mention the bot, then open Messaging Activity. PwrAgent starts the adapter in
discovery mode, discards the unauthorized inbound message, and logs the Slack
user ID there so you can copy it into the allowlist. The connection-test button
calls Slack `auth.test` with the bot token.

**Path B — Environment variables.** Env vars override Settings UI values when
both are present.

```bash
PWRAGENT_MESSAGING_SLACK_ENABLED=true
PWRAGENT_MESSAGING_SLACK_BOT_TOKEN=xoxb-...
PWRAGENT_MESSAGING_SLACK_APP_TOKEN=xapp-...
PWRAGENT_MESSAGING_SLACK_SIGNING_SECRET=...                    # optional in Socket Mode
PWRAGENT_MESSAGING_SLACK_AUTHORIZED_USER_IDS=U012ABCDEF0,U099ZZZZZZZ
PWRAGENT_MESSAGING_SLACK_AUTHORIZED_WORKSPACES=T012ABCDEF0   # optional
PWRAGENT_MESSAGING_SLACK_WORKSPACE_URL=https://example.slack.com # optional
PWRAGENT_MESSAGING_SLACK_STREAMING_RESPONSES=false              # optional
PWRAGENT_MESSAGING_SLACK_REGISTER_SLASH_COMMANDS=false          # reserved
PWRAGENT_MESSAGING_SLACK_SLASH_COMMAND_PREFIX=pwragent_         # optional
```

Authorize on stable Slack user IDs (`U…` or enterprise `W…`), not display names
or handles. Workspace allowlisting uses Slack team IDs (`T…`). Leaving the
workspace list empty means "accept events from any workspace installation of
this Slack app." That is fine for a non-distributed one-workspace app, but if
the app is ever distributed or installed into another workspace, the same Socket
Mode app token can receive events for those installations. Add your expected
`T…` workspace ID to make the desktop bot reject events from any other
workspace before user authorization.

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
