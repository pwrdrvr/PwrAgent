# Messaging Platform Integration

PwrAgent can run messaging adapters from the Electron main process so an
allowlisted Telegram, Discord, or Mattermost user can choose a thread, bind
the current conversation, and send free-form text into that thread. The
workflow logic is shared; the providers only own transport, formatting,
callback handles, and platform limits.

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
  want PwrAgent to register `/resume`, `/status`, `/detach` as native
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
canonical command set (`/resume`, `/status`, `/detach`) against every team
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

**Path A — Desktop Settings UI (recommended for desktop users).** Open Settings → Messaging → Mattermost. Fill in the bot token (Keychain), server URL, callback base URL, callback port, authorized user IDs, and the optional slash-command toggles. The `Test` button on the Bot Token row hits `<serverUrl>/api/v4/users/me` with the token to confirm both pieces. Slash commands are off by default — see "Slash command registration" below.

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

If you operate Mattermost 11.0+ (which adds `root_id` to slash-command bodies) or you accept the v10.x channel-reply tradeoff, opt in via the Settings UI toggle or `PWRAGENT_MESSAGING_MATTERMOST_REGISTER_SLASH_COMMANDS=true`. With the toggle on, PwrAgent reconciles its canonical command set against every team the bot is a member of on adapter startup. The `slashCommandPrefix` field controls the namespace (default `pwragent_` → `/pwragent_help`, `/pwragent_status`, `/pwragent_resume`, `/pwragent_detach`); set it blank to register bare triggers and accept the collision risk with built-in commands like `/status`, `/away`, `/leave`.

Authorize on stable Mattermost user IDs (UUIDs visible via Settings →
Profile → Account Settings → Display → Username, then
`/api/v4/users/username/<name>` returns the `id`). Mutable usernames
are not authorization-safe.

`PWRAGENT_MESSAGING_MATTERMOST_SLASH_COMMAND_PREFIX` controls the
namespace prepended to every registered slash-command trigger.
Default: `pwragent_`, which gives `/pwragent_resume`, `/pwragent_status`,
`/pwragent_detach` — chosen to avoid collisions with built-in
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

> **Note for future-you:** When the Settings UI lands, the desktop
> will mint and persist the HMAC in macOS Keychain on first run.
> Until then, env-var pinning is the only stable path. Without it,
> "buttons stop working after restart" is the most common confused
> bug report against this adapter.

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
    namespaced commands (`/pwragent_resume`, `/pwragent_status`,
    `/pwragent_detach` by default) should appear in the autocomplete
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

1c-help. Send `@pwragent help` (or `/pwragent_help`) anywhere the
    bot can see. The bot replies with the canonical command list
    and notes both invocation styles.
1d. From a separate browser/account that is NOT in
    `PWRAGENT_MESSAGING_MATTERMOST_AUTHORIZED_USER_IDS`, run
    `/pwragent_resume`. The command executes (Mattermost has no
    per-user permission gating on bot commands) but PwrAgent
    rejects the actor and returns the ephemeral text "You are not
    authorized to use this command." — visible only to the invoker.

**DM bind flow:**

2. Open a Direct Message to the bot in Mattermost. Send a naked
   message: `You there?`
3. The bot replies with a `Choose a thread` post containing a `Resume`
   button.
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

**Detach:**

15. Click `Detach` on the status card. The bot posts `Thread detached`
    and removes the status card's buttons. The desktop app's binding
    chip disappears for that thread.
16. Send another message in the DM. The bot does not respond
    (binding gone), but the offered `Resume` button on the
    `Choose a thread` reply still works to re-bind.

**Cross-restart persistence (with env-var HMAC pinned):**

17. Quit and relaunch PwrAgent.
18. Click a button on a status card from a still-bound thread that
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
