---
layout: page
title: Messaging concepts
---

# Messaging concepts

PwrAgent's messaging system is the bridge between the desktop coding
agent and the chat platforms you live in. This page covers the concepts
that show up in every per-platform setup guide. Read it once; the
platform pages assume you know it.

## Bindings

A **binding** ties a thread on the desktop to a specific conversation on
a messaging platform — a Telegram DM, a Slack channel, a Discord
channel, a Mattermost direct message, and so on. Once bound:

- Free-form text from the conversation enters the thread as user input.
- The agent's responses, status updates, and approval prompts appear
  in the conversation as bot messages.
- The desktop's binding chip shows which platform and which
  conversation the thread is attached to.

A thread can carry multiple bindings (one Telegram, one Slack, all on
the same thread). Each binding renders independently using its
platform's native components.

You create a binding by sending `/resume` (or `@PwrAgent resume`) from
an authorized conversation, picking the thread, and confirming. You
unbind with `/detach` or from the desktop's right-click menu on the
binding chip.

## Authorization

Messaging is closed by default and stays that way.

- **Only allowlisted platform user IDs can DM the bot.** A user ID is
  the platform's immutable identifier — a Slack `U…`, a Discord
  snowflake, a Telegram numeric ID — *not* a username or display name.
- **Inside shared spaces** (Slack workspaces, Discord servers, Telegram
  supergroups, Feishu groups) authorization is **two-keyed**: the space
  has to be allowlisted *and* the user has to be allowlisted. Inviting
  the bot into a workspace doesn't authorize anyone in it. Being in an
  authorized workspace doesn't authorize a user.
- **Unauthorized attempts are denied and logged** in Settings → Messaging
  → Activity. You can see who tried and from where. The bot does not
  respond to unauthorized users.
- **Adding a new authorized user or space is a deliberate, opt-in
  change** made from the desktop Settings UI — never a side effect of
  someone discovering the bot.

If you launch a fresh adapter with an empty user allowlist, it starts
in **discovery mode** — the adapter connects, every inbound message is
discarded as unauthorized, and the rejected user's stable ID is logged
in Messaging Activity so you can copy it into the allowlist. This is
the recommended way to find a user's ID without leaving the app.

## Commands

Every platform exposes the same command surface:

| Command | What it does |
|---|---|
| `/resume` | Open the recents browser — pick an existing thread to bind |
| `/new` | Open the new-thread project picker |
| `/status` | Refresh the pinned status card for the current binding |
| `/detach` | Detach the current binding |
| `/monitor` | Post a snapshot of recent thread activity |
| `/help` | Show the canonical command list with buttons |

On Telegram, Discord, Mattermost, and Slack, you can also invoke verbs
by mentioning the bot: `@PwrAgent resume`, `@PwrAgent new`, etc. A bare
mention shows the command menu.

## Status card

When you bind a thread, the bot pins (or posts) a **status card** in
the conversation. The card shows the thread's current model, reasoning
effort, fast mode, permissions mode, tool-update verbosity, and
streaming mode — all changeable per-binding from the card's buttons.

When you change a setting from the desktop, the card refreshes on the
messenger; when you change one from the card, the desktop UI updates
the same way. The card is the single source of cross-surface state.

## Typing indicators

Bot typing indicators turn on while a bound turn is waiting on the
agent, and off when the turn completes, fails, is interrupted, or hits
an approval / questionnaire prompt. Intermediate assistant updates and
tool-progress messages don't stop typing — only terminal lifecycle
events do.

## Streaming responses

Streaming **is not** "you'll get a new message for each part of the
agent's reply." It's "the bot's reply message will be edited in place
as text arrives." It usually breaks message readers and consumes
rate-limit budget faster than the same response sent in one chunk.

The default is off, and that's the right default for almost everyone.
See [Streaming responses: why you probably don't want them](streaming.md).

## Tool-update verbosity

PwrAgent can also send progress messages summarizing the agent's tool
activity — "Read app.tsx", "Ran build", and so on. The verbosity dial
goes from `Show None` to `Show All`, with `Show Some` as the default.

The default sends up to three quiet updates individually, then batches
the rest every 30 seconds. That balances visibility against the
rate-limit budget. The `Tools: <mode>` button on the status card
changes the mode per-binding.

## Slow Mode and Cool Off

Two related-but-distinct protection states:

- **Slow Mode** is PwrAgent's local budget-protection. It kicks in
  when a provider scope is close to its write budget. In Slow Mode,
  final assistant messages and interactive prompts still go through;
  non-final streaming edits, routine status-card edits, and
  intermediate tool updates may be dropped.
- **Cool Off** is provider-imposed. It kicks in when a platform returns
  a rate-limit response with a retry window. PwrAgent stops sending to
  that scope until the retry clears, then resumes conservatively.

The messaging status dot turns orange while either is active.

## Attachments

Bound conversations can send supported attachments into the thread:

- Bounded text-like files (`.txt`, `.md`, `.csv`, `.json`, `.jsonl`,
  `.toml`, `.yaml`, `.yml`, logs).
- Images (rendered through the same upload profile as desktop paste).
- GIFs as still images for model input.
- PDFs when text can be extracted.

Audio / video, archives, OCR-only PDFs, and oversized files are
rejected with a short bot message instead of being uploaded to a
model.

## Where state lives

Bindings, callback handles, pending intents, and the messaging activity
log live in PwrAgent's sqlite state DB at
`~/.pwragent/profiles/<name>/state/state.db`. Bot tokens and other
secrets are encrypted at rest by Electron `safeStorage`, backed by
macOS Keychain.

## What's next

- Pick your platform from the [docs landing page](../index.md).
- Read [streaming.md](streaming.md) before flipping the streaming
  toggle.
- If you're using LINE or Mattermost, read
  [webhook-dangers.md](webhook-dangers.md) before exposing a callback
  URL.
