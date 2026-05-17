---
layout: page
title: Slack
redirect_from:
  - /messaging/slack/
  - /messaging/slack
---

# Slack

PwrAgent's Slack adapter uses **Socket Mode** — PwrAgent dials out to
Slack, no public Request URL is needed.

## What you need to get started

- **A Slack app** you've created in your workspace.
- A **bot token** (`xoxb-…`) from that app.
- An **app-level token** (`xapp-…`) with the `connections:write` scope
  for Socket Mode.

You don't need a public webhook URL. You don't need to configure a
Request URL on Event Subscriptions or Interactivity.

## Step by step

The most common reason setup fails is doing these steps in the wrong
order — Slack steers you toward the Request-URL flow if Event
Subscriptions are configured before Socket Mode. Follow the order
below.

1. **Create the Slack app.** Go to
   [api.slack.com/apps](https://api.slack.com/apps), **Create New App**,
   pick **From scratch**, name it (e.g. `PwrAgent`), pick the target
   workspace.
2. **Enable Socket Mode first.** In your app, go to **Socket Mode**
   and turn on **Enable Socket Mode**. *Do this before opening Event
   Subscriptions or Interactivity & Shortcuts.* If you've already
   configured those, Slack may force a Request URL; turn off the
   Request URL requirement after enabling Socket Mode.
3. **Create the app-level token.** Still in Socket Mode, create an
   app-level token with the `connections:write` scope. Slack returns a
   token starting with `xapp-`. Copy it.
4. **Add the bot user.** In **OAuth & Permissions**, add the bot scopes
   (see "Minimum scopes" below). Then install the app to the workspace.
   Slack returns a bot token starting with `xoxb-`. Copy it.
5. **Configure Event Subscriptions.** In **Event Subscriptions**, turn
   on events, subscribe the bot to the message events you need:
   - `message.channels` — public channels
   - `message.groups` — private channels
   - `message.im` — DMs
   - `message.mpim` — multi-person DMs
   - `app_mention` — bot mentions

   With Socket Mode on, Slack should not require a Request URL.
6. **Configure Interactivity & Shortcuts.** Enable interactivity for
   Block Kit button clicks. Again, no public Request URL is needed.
7. **Open Settings → Messaging → Slack** in PwrAgent.
8. **Paste the bot token and the app-level token.** Click **Save**.
9. **Click Test.** PwrAgent calls `auth.test` to verify the bot token.
10. **Enable Slack** with the toggle at the top of the panel.
11. **DM or `@mention` the bot.** With the user allowlist empty,
    Settings → Messaging → Activity logs your Slack user ID for the
    rejected attempt. Copy the `U…` value into the authorized list.
12. **Try `/resume`** or `@PwrAgent resume`.

### Minimum bot scopes

- `chat:write` — outbound messages and updates.
- `channels:history`, `groups:history`, `im:history`, `mpim:history` —
  for the conversation types you want the bot to operate in. These
  scopes also let PwrAgent fetch a thread's root message so binding
  chips can show `#channel/root message` instead of a generic
  `#channel/Thread` label.
- `channels:read`, `groups:read`, `im:read`, `mpim:read` — optional,
  recommended for friendlier channel-name labels in chips.
- `files:read`, `files:write` — inbound and outbound file handling.
- `users:read` — optional but recommended; lets PwrAgent label DM
  bindings and Activity entries with the person's profile name
  instead of their `U…` ID.
- `commands` — only if you're registering Slack slash commands.

{% include figure.html
   src="/assets/screenshots/settings-messaging-slack.png"
   alt="Settings → Messaging → Slack panel"
   caption="<strong>Settings → Messaging → Slack</strong>. <strong>Test</strong> confirms PwrAgent can reach the Slack API; <strong>Authorized User IDs</strong> is populated by the <a href='../../messaging/pairing/'>Pairing</a> flow."
%}

## Pairing

For the captured walkthrough of the pairing flow (generate → send
code → approve), and the troubleshooting Activity screen that shows
blocked inbound messages, see
[Messaging → Pairing](../../messaging/pairing/). Same flow on every
supported platform; the screenshots there happen to be Telegram.

## Settings reference

### Required (above the Test button)

| Setting | What it does |
|---|---|
| **Enabled** | Top-of-panel toggle. When off, the adapter doesn't start. |
| **Bot Token** | `xoxb-…` from the OAuth & Permissions tab. Stored in macOS Keychain. |
| **App Token** | `xapp-…` from the Socket Mode tab. Required for the WebSocket connection. Stored in macOS Keychain. |
| **Authorized User IDs** | Comma-separated `U…` IDs (or enterprise `W…`). Pairing or activity-log discovery populates this. |

### Optional (below the Test button)

| Setting | Default | What it does | When to change |
|---|---|---|---|
| **Inbound Mode** | Socket Mode | Reserved switch for a future Events API path. | Leave on Socket Mode — it's the supported inbound transport today. |
| **Signing Secret** | (blank) | Optional in Socket Mode. PwrAgent uses it as a stable local secret for Block Kit button payload validation. | Set it. With a stable signing secret, buttons rendered before an adapter restart still validate after the restart. Without it, button payloads use a per-process random secret and stale buttons silently fail after a restart. Get the value from Basic Information → App Credentials → Signing Secret. |
| **Workspace ID Allowlist** | (empty) | Comma-separated team IDs (`T…`) the bot will accept events from. Empty = accept from any workspace this app is installed into. | Set when the app might be distributed or installed into more than one workspace and you want to reject events from anywhere else. |
| **Workspace URL** | (blank) | Display-only metadata for binding chips. | Set to your workspace's URL (e.g. `https://example.slack.com`) for nicer Activity entries. |
| **Streaming Responses** | Off | Bot edits its reply message in place as the response streams in. | Leave off. See [Streaming responses](/streaming/). Slack edits are more permissive than Telegram, but `chat.postMessage` has its own write limit. |
| **Tool Usage Notifications** | Show Some | Same as the global Tools setting. | Per-binding override available on the status card. |
| **Image Upload Profile** | medium | Quality used when forwarding inbound images to the model. | `low`/`high`/`actual` per your bandwidth / fidelity tradeoff. |

## Slack-specific notes

- **One Slack app per desktop bot identity.** If twenty people each
  run their own PwrAgent, the safest deployment is twenty Slack apps.
  Sharing one app token / bot token across many desktop instances
  means every instance connects as the same bot and may double-handle
  events. There is no current sharding story for that case.
- **DM edits and channel edits are more permissive than Telegram**, but
  `chat.postMessage` has its own special rate limit. Don't treat
  Slack as "free edits."
- **Slash commands are currently reserved.** PwrAgent registers
  Slack slash commands only when you flip the explicit toggle; the
  recommended invocation path is `@PwrAgent resume` text-mention,
  which works on every Slack workspace without per-app configuration.

## See also

- [Using Codex via Messaging](/using-codex/)
- [Streaming responses](/streaming/)
