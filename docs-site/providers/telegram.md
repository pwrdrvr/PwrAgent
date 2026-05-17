---
layout: page
title: Telegram
redirect_from:
  - /messaging/telegram/
  - /messaging/telegram
---

# Telegram

PwrAgent's Telegram adapter uses long polling — PwrAgent dials out to
Telegram, no public callback URL or webhook tunnel is needed.

## What you need to get started

**A bot token from BotFather.** That's it. You do not need:

- Your Telegram user ID (numeric)
- Your bot's user ID (numeric)
- Any supergroup ID (negative number)

PwrAgent discovers the bot's ID from the token at startup, and a
self-service pairing flow handles your user ID. The bot token is the
single piece of information you have to bring.

## Step by step

1. **Create the bot.** Open Telegram, message
   [@BotFather](https://t.me/BotFather), send `/newbot`, and follow the
   prompts. BotFather replies with a bot token (looks like
   `123456789:ABCdefGhIjKlMnOpQrStUvWxYz`). Copy it.
2. **Open Settings → Messaging → Telegram** in PwrAgent.
3. **Paste the bot token** into the Bot Token field. Click **Save**.
4. **Click Test.** PwrAgent calls `getMe` against the Telegram Bot API.
   On success, the row reports the bot's username and bot ID — that
   confirms the token is valid and PwrAgent can reach Telegram.
5. **Enable Telegram** with the toggle at the top of the panel.
6. **Generate a pairing token.** In Settings → Messaging → Telegram,
   click **Generate pairing token**. PwrAgent shows a short
   one-time code.
7. **Send the pairing code to your bot.** Open the bot's DM in Telegram
   and send the code as a regular message.
8. **Approve the pairing.** A pairing confirmation appears in PwrAgent's
   Settings panel. Approve it. Your Telegram user ID is now on the
   authorized-user allowlist; the desktop has discovered who you are
   without you needing to find your numeric ID anywhere.
9. **Try `/resume`.** Send `/resume` (or `@<botusername> resume`) from
   that DM. The bot replies with the thread picker.

If the pairing-DM step doesn't work, you can fall back to the
discovery path: leave the authorized-user list empty, send any message
to the bot, and open Settings → Messaging → Activity. PwrAgent
discards the unauthorized message and logs your Telegram user ID
there. Copy the ID into the authorized list. The pairing flow is just
the friendlier version of that same path.

{% include figure.html
   src="/assets/screenshots/settings-messaging-telegram.png"
   alt="Settings → Messaging → Telegram panel"
   caption="<strong>Settings → Messaging → Telegram</strong>. <strong>Test</strong> confirms PwrAgent can reach the Telegram Bot API; <strong>Authorized User IDs</strong> is populated by the <a href='../../messaging/pairing/'>Pairing</a> flow."
%}

For the captured walkthrough of the pairing flow (generate → send
code → approve), and for the troubleshooting Activity screen that
shows blocked inbound messages, see
[Messaging → Pairing](../../messaging/pairing/). Same flow on every
supported platform; the screenshots there happen to be Telegram.

## Settings reference

### Required (above the Test button)

| Setting | What it does |
|---|---|
| **Enabled** | Top-of-panel toggle. When off, the adapter doesn't start. |
| **Bot Token** | The BotFather token. Stored encrypted at rest in your macOS Keychain. The Test button calls `getMe` to verify. |
| **Authorized User IDs** | Comma-separated list of stable Telegram numeric user IDs. The pairing flow populates this; you can also paste IDs in directly. Empty = discovery mode (every inbound is rejected and logged). |

### Optional (below the Test button)

| Setting | Default | What it does | When to change |
|---|---|---|---|
| **Streaming Responses** | Off | When on, the bot edits its reply message in place as the agent's response arrives. | Leave off. Edits eat Telegram's tight rate-limit budget and break voice readers. See [Streaming responses](/streaming/). |
| **Tool Usage Notifications** | Show Some | Controls how often PwrAgent posts progress messages for the agent's tool calls. | `Show More` if you want more visibility, `Show Less` or `Show None` to quiet the channel. The status card's `Tools: <mode>` button overrides per-binding. |
| **Image Upload Profile** | medium | Quality / size used when forwarding inbound images to the model. | `low` if uploads are slow, `high` / `actual` if you're sharing screenshots with text the model needs to read. |
| **Input Debounce (ms)** | 500 | How long PwrAgent waits after a message before starting a turn, so multi-part messages stay in one turn. | Increase if you tend to send multi-part messages over a few seconds; `0` disables the wait entirely. |

## Telegram-specific notes

- **Supergroup write budgets are shared across topics.** If you bind
  multiple active PwrAgent threads to different topics in the same
  supergroup, they share the supergroup's ~20 msg/min budget. Use one
  supergroup per active thread for serious work; topics are fine for
  read-mostly bindings.
- **DM budget is roughly 60 msg/min.** Plenty for normal use, but
  streaming-on responses can burn through this in a single long turn.
- **PwrAgent clears any configured Telegram webhook on startup.** If
  you previously experimented with webhook mode on this bot, the long
  polling adapter takes precedence and silently clears the webhook
  setting.
- **Mention parsing requires `getMe` to succeed at startup.** If
  `getMe` fails (network blip, expired token), `@<botusername> resume`
  won't work until the next restart, though slash commands still do.
- **Telegram does not support edits on the General topic of a forum
  supergroup**; PwrAgent automatically falls back to posting a new
  message when an edit isn't allowed.

## Why you do not need to use a webhook

Telegram supports both long polling (the bot dials out) and webhook
mode (Telegram dials in to a public URL you host). PwrAgent uses long
polling. The author worked on Telegram webhook delivery in
[OpenClaw](https://github.com/pwrdrvr/openclaw-codex-app-server) and
confirmed it does not improve message delivery time vs. long polling.
The webhook path adds public-internet attack surface for no measurable
benefit. See [Webhooks — a security note](/webhook-dangers/).

## See also

- [Using Codex via Messaging](/using-codex/) — bindings, commands,
  status card, tool updates, slow mode.
- [Streaming responses](/streaming/)
- [Webhooks — a security note](/webhook-dangers/)
