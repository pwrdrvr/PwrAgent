# Feishu / Lark Provider Setup Notes

These notes capture the manual setup path validated while building the
PwrAgent Feishu / Lark adapter. They are provider-local implementation notes,
not yet polished end-user documentation.

## Platform Choice

- Feishu is the China-region product and uses `https://open.feishu.cn`.
- Lark is the rest-of-world product and uses `https://open.larksuite.com`.
- PwrAgent uses `feishu` as the internal provider/channel identifier for both.
- In the Lark signup flow, use a business/workspace account for an internal bot
  app. The PwrDrvr LLC validation path used Lark Developer with an internal app.

## PwrAgent Settings

1. Open Settings > Messaging > Feishu / Lark.
2. Select the tenant region:
   - Feishu for China-only tenants.
   - Lark for rest-of-world tenants.
3. Store the App ID and App Secret in Keychain.
4. Run the connection test. It should mint a tenant access token and call the
   low-permission bot info endpoint.
5. Enable the provider only after the app credentials are configured and the
   Lark/Feishu console event modes are verified.
6. Leave Tenant URL blank unless testing a non-standard Open Platform endpoint.
7. Use Persistent event subscription by default. Only select Webhook when the
   deployment intentionally exposes a public callback URL.

## Lark / Feishu Developer Console

Create a custom/internal app and enable the Bot capability.

Configure both Event Configuration and Callback Configuration to use:

`Receive events/callbacks through persistent connection`

This is the supported default. The desktop app opens an outbound SDK WebSocket,
so users do not need to expose a localhost listener through Cloudflare Tunnel,
ngrok, or another public reverse proxy that can be scanned by internet traffic.

Enable Encryption Strategy and store the generated Encryption Key in PwrAgent.
Encryption is recommended for persistent connection and webhook modes; PwrAgent
decrypts encrypted event envelopes before it validates and dispatches them.

After changing bot profile, scopes, events, or callbacks, create and publish an
app version. Lark indicates that profile and permission changes take effect
after publish.

## Events

Required:

- `im.message.receive_v1` - delivers DMs and group mention messages.
- `card.action.trigger` - delivers interactive-card button clicks such as
  Resume, Next, Projects, New, Cancel, Approve, and Reject.

Optional/noisy:

- `im.chat.access_event.bot_p2p_chat_entered_v1` - emitted when a user opens
  the bot DM. PwrAgent records a diagnostic and waits for a real message.

Not currently consumed, but potentially useful later:

- `im.chat.member.bot.added_v1`
- `im.chat.member.bot.deleted_v1`
- `im.message.message_read_v1`
- `im.message.reaction.created_v1`
- `im.message.reaction.deleted_v1`
- `im.message.updated_v1`

## Scopes

Useful current scopes:

- `im:message.group_at_msg:readonly` - receive users' mentions in groups.
- `im:message:send_as_bot` - send replies and status cards as the bot.
- `im:message:readonly` - read direct and group chat messages for message
  receive events and download image/file resources from received messages.
- `im:message:update` - update/dismiss status cards instead of posting
  duplicates.
- `im:chat:readonly` - obtain group information for shared-chat use.

Broader shortcut:

- `im:message` - read and send direct messages and group chat messages. This is
  acceptable for a private internal app, but narrower scopes are easier to
  justify during approval.

Only add `im:message.group_at_msg.include_bot:readonly` if events for mentions
from other bots are explicitly needed.

## Pairing and Authorization

PwrAgent starts in discovery mode if Feishu / Lark is enabled with no authorized
users. Inbound events are rejected and logged in Messaging Activity so the
operator can copy IDs.

Pairing flow:

1. Generate a pairing token in Settings.
2. Send `pair <token>` to the bot in a DM, or mention the bot with
   `@PwrAgent pair <token>` in a group.
3. Approve the observed pairing request in Settings.
4. Confirm the authorized user `open_id` starts with `ou_`.
5. For group/shared chats, authorize the chat ID starting with `oc_`.
6. Optionally authorize the tenant key shown in Messaging Activity.

Bound group chats still require mentioning the bot for PwrAgent to receive
messages. Use `@PwrAgent ...` in a bound group. DMs do not require a mention.

Image and file messages are passed through the shared attachment processor
after authorization. Audio/video messages are recorded as unsupported
attachments until a transcription or media-processing path exists.

## Troubleshooting

- Startup log containing `event-dispatch is ready` plus the SDK persistent
  connection hint is normal. It is the SDK telling operators where persistent
  connection mode is configured.
- If DMs do not produce `im.message.receive_v1` logs, verify Event
  Configuration is persistent-connection mode, the message receive event is
  subscribed, scopes were granted, and the app version was published.
- If group messages are rejected with `unauthorized-actor`, add the user's
  `ou_...` open ID and the group's `oc_...` chat ID from Messaging Activity.
- If card button clicks show Lark client error `200340` and PwrAgent logs no
  `eventType=card.action.trigger`, Callback Configuration is not reaching
  PwrAgent. Set Callback Configuration to persistent connection and subscribe
  `card.action.trigger`.
- If card callbacks are logged but actions expire unexpectedly, inspect the
  sqlite-backed pending intent/callback handle store before assuming an
  in-memory handle path.
- If assistant tables render in the desktop app but appear as raw pipe text in
  Lark, ensure the Feishu adapter is using interactive cards for markdown table
  messages instead of plain text messages.

## Webhook Fallback

Webhook mode is a fallback. Persistent connection is preferred.

If webhook mode is selected:

1. Configure Event Configuration and Callback Configuration to send
   notifications to the developer server.
2. Expose a public URL that forwards to the local listener.
3. The local default listener is `http://127.0.0.1:47823`.
4. Store the Verification Token in Keychain.
5. Enable encrypted callbacks in the platform console and store the Encryption
   Key in Keychain. Encryption is recommended for persistent connection and
   webhook modes; PwrAgent decrypts encrypted event envelopes before dispatch.

Do not enable the local webhook listener unless Webhook is selected for Event
subscription.
