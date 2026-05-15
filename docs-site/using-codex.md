---
layout: page
title: Using Codex via Messaging
permalink: /using-codex/
redirect_from:
  - /messaging/overview/
  - /messaging/overview
---

# Using Codex via Messaging

This is the operator's guide to driving Codex from a paired
messenger. It assumes you've already paired a bot for at least one
platform — if you haven't, start with the
[provider setup pages](providers/) and come back. The rest of this
page is mostly the same across every supported platform; per-provider
exceptions are called out inline.

Once a thread is **bound** to a messenger conversation, raw text and
attachments from that conversation route **directly into the Codex
thread**. There's no intermediate agent watching over your shoulder
— you're using Codex through a thin transport that translates between
the chat platform and the agent. The desktop and the messenger stay
in sync on every state change.

## Contents

**Access and invocation**

- [Who can talk to the bot](#who-can-talk)
- [Slash commands and buttons](#slash-commands-and-buttons)
- [At-mention commands](#at-mention-commands)

**Starting a thread**

- [What is a bound thread?](#what-is-a-bound-thread)
- [Resume Thread browser](#resume-thread-browser)
- [New Thread starter](#new-thread-starter)
- [Start Card buttons](#start-card-buttons)
- [Sending the first prompt](#first-prompt)

**While the thread is bound**

- [Status card on a bound thread](#status-card-bound)
- [Skills browser](#skills-browser)
- [Tool-update verbosity](#tool-update-verbosity)
- [Typing indicators](#typing-indicators)
- [Sending attachments](#attachments)

**During a turn**

- [Debounce, queue, and steer](#debounce-queue-steer)
- [Monitor cards](#monitor-card)

**Ending or rebinding**

- [Detaching a thread](#detaching-a-thread)
- [Archiving a thread](#archiving-a-thread)

---

## Who can talk to the bot {#who-can-talk}

PwrAgent's messaging is **closed by default**, and stays that way.
The bot doesn't reply to anyone you haven't explicitly authorized.
Unauthorized attempts are denied silently and logged to the desktop's
**Settings → Messaging → Activity** view so you can see who tried.

Authorization is **two-keyed** for shared spaces:

- **Direct messages** require the sender's **user ID** to be on the
  per-platform authorized list.
- **Shared spaces** (Slack workspaces, Discord servers, Telegram
  supergroups, Feishu groups, Mattermost teams, LINE groups/rooms)
  require **both** the user ID **and** the space ID to be on their
  respective allowlists. Inviting the bot into a workspace authorizes
  nobody automatically. Being in an authorized workspace doesn't
  authorize a user.

Both lists live in your local PwrAgent config at
`~/.pwragent/profiles/<name>/config.toml` — they are **not** stored
in sqlite, are never synced to a server, and never leave your
machine. Adding a new authorized user or space is a deliberate edit
made from **Settings → Messaging → `<platform>`** in the desktop.

### Pairing — how you populate the allowlists

PwrAgent provides a **pairing flow** that handles both allowlists
across every provider without you needing to find a numeric ID
anywhere. The same flow has two phases:

1. **Pair yourself as a user.** Click **Generate pairing token** in
   Settings → Messaging → \<platform\>. PwrAgent shows a short
   one-time code. Send that code to the bot — in a DM where direct
   messages exist, or from inside the space you'll later pair on
   DM-less surfaces. A confirmation prompt appears on the desktop.
   Approve it; your platform user ID joins the user allowlist.

2. **Pair a shared space** (once you're an authorized user). Same
   mechanic: generate another token, post it in the space you want
   to allowlist, approve on the desktop. The space ID joins the
   per-platform space allowlist. The user who pairs a space has to
   already be on the user allowlist — that's the two-keyed model in
   action.

The available space types vary by platform: Telegram has DMs and
supergroups; Discord has DMs, servers, and channels within servers;
Slack has DMs, workspaces, and channels within workspaces;
Mattermost has DMs, teams, and channels within teams; Feishu / Lark
has DMs and group chats; LINE has 1:1 chats, group chats, and
multi-person rooms. The pairing flow applies to whichever level
your platform exposes.

For a captured walkthrough of what each phase looks like in the
desktop UI — including the troubleshooting Activity screen that
shows blocked inbound messages — see
[Messaging → Pairing](../messaging/pairing/).

### Discovery-mode fallback

If pairing isn't convenient (or you'd rather copy-paste IDs), the
fallback works on every provider: launch with an empty user
allowlist, send the bot any message from your account, open
**Settings → Messaging → Activity**, and copy the platform user ID
PwrAgent logged for your rejected attempt into the user allowlist.
Same end result, same two-keyed model — just more typing.

### Stable IDs only

Usernames, display names, guild nicknames, and other mutable
identifiers are **not** authorization-safe. PwrAgent ignores them
when matching against the allowlists; only the platform's immutable
ID for the user / workspace / supergroup / channel / room counts.

## Slash commands and buttons {#slash-commands-and-buttons}

Every platform exposes the same six commands:

| Command | What it does |
|---|---|
| `/resume` | Open the [Resume Thread browser](#resume-thread-browser) — pick an existing thread to bind |
| `/new` | Open the [New Thread starter](#new-thread-starter) directly (project picker → start card) |
| `/status` | Refresh the pinned status card for the current binding |
| `/detach` | [Detach](#detaching-a-thread) the current binding |
| `/monitor` | Post a [monitor card](#monitor-card) for the current binding's thread |
| `/help` | Show the canonical command menu with buttons |

On platforms that support native slash-menus (Telegram, Discord,
Slack, Mattermost, Feishu), PwrAgent registers these on startup so
they appear in the platform's `/` autocomplete. The buttons next to
each command on the help menu are equivalent — `/resume` and the
**Resume** button do the same thing.

If your platform doesn't have a slash menu visible (or you're on a
keyboard where it's awkward), use [at-mention commands](#at-mention-commands)
instead. Both paths dispatch to the same handler.

<details markdown="1">
<summary>Per-provider exceptions</summary>

| Provider | Exception |
|---|---|
| **Mattermost** | Slash commands invoked from inside a channel thread can route back to the parent channel on Mattermost server v10.x and earlier. PwrAgent works around this on the first delivery via Mattermost's `response_url` endpoint, but `@<bot> resume` from inside the thread is more reliable. Server v11.0+ fixes this. |
| **Discord** | Slash-command registration silently no-ops if the Application ID isn't configured in PwrAgent. The bot still listens for at-mentions, but `/resume` etc. won't appear in the `/` menu. |
| **Slack** | Slack slash commands are registered only when you flip the explicit toggle in Settings → Messaging → Slack. The recommended path on Slack is `@PwrAgent resume` text mention, which works in every workspace without per-app slash-command configuration. |
| **Mattermost** (label) | Action buttons are capped at 40 characters of label — long model names truncate hard. Prefer text fallback (`reply 1`) over button clicks when labels read as ambiguous. |
| **LINE** | Buttons on LINE are the most restrictive of any supported platform: **13 actions per message maximum** (tightest budget) and **20-character label cap** (tied for shortest, with Feishu). LINE also **doesn't support editing messages**, so paginated button surfaces — the [Resume Thread browser](#resume-thread-browser), the [New Thread starter](#new-thread-starter), the `/help` menu — post a **fresh card** on every Prev / Next / page-change click instead of editing the existing card in place. The combination makes button-driven flows noisier on LINE than elsewhere; prefer text fallback (`reply 1`, `next`, `back`, `cancel`) when a button reads as ambiguous or you don't want a chain of replacement cards in the conversation. |

</details>

## At-mention commands {#at-mention-commands}

> **Naming convention used in this guide.** Throughout this page,
> **`@PwrAgent`** is a stand-in for whatever handle you actually gave
> the bot on the platform you're using. On Telegram, that's the
> `@username` you set in BotFather (e.g., `@my_codex_bot`); on
> Discord and Slack, it's the bot's display name (your client renders
> the mention as a rich `@<name>` tag once you select it from the
> autocomplete); on Mattermost, it's the bot account username. Read
> every `@PwrAgent` below as "the at-mention syntax for your bot on
> your platform."

Anywhere the bot can read messages, you can invoke the same verbs by
mentioning the bot followed by the verb:

```
@PwrAgent resume
@PwrAgent new
@PwrAgent status
@PwrAgent detach
@PwrAgent monitor
@PwrAgent help
```

This path works **even if the platform's slash-command registration
isn't configured** — handy on Slack (where slash is opt-in) and as a
fallback on any platform when the `/` menu isn't readily reachable.

A **bare mention** (just `@PwrAgent` with no verb) shows the help
menu with Resume and New buttons. From there you can pick the action
without typing.

<details markdown="1">
<summary>Per-provider exceptions</summary>

| Provider | Exception |
|---|---|
| **Telegram** | The bot needs to have completed `getMe` successfully at startup to recognize its own username for mention parsing. If `getMe` fails (network blip, expired token), `@<botusername>` mention parsing is silently disabled until the next adapter restart. Slash commands still work. |
| **Discord** | Mention parsing matches on the bot's Application ID. If Application ID isn't set in PwrAgent, `@PwrAgent <verb>` won't dispatch — slash still does. |
| **Discord** (uploads) | A bare bot mention sent as a media caption is intentionally **not** a help trigger — the upload routes as media instead. Send `@PwrAgent` in a plain text message for help. |

</details>

## What is a bound thread? {#what-is-a-bound-thread}

A **binding** ties a Codex thread on the desktop to a specific
conversation on a messenger — a Telegram DM, a Slack channel, a
Discord thread, a Mattermost direct message, a Feishu group chat,
a LINE 1:1.

Once bound:

- **Raw text from the conversation routes straight into the Codex
  thread as user input.** No intermediate agent, no pre-processing,
  no rewriting. You're using Codex directly.
- The agent's responses, status updates, approval prompts, and tool
  progress appear in the conversation as bot messages.
- The desktop's binding chip on the thread shows which platform and
  which conversation are attached.

A thread can carry **multiple bindings** at once — one Telegram, one
Slack, all driving the same thread. Each binding renders
independently using its platform's native components, so a Discord
user sees Discord-native buttons and a Telegram user sees Telegram
inline keyboards on the same conversation.

State lives in the desktop's sqlite store (`bindings` table). Bot
tokens, callback secrets, and other credentials live encrypted at
rest via macOS Keychain and never travel over the messenger.

## Resume Thread browser {#resume-thread-browser}

<!-- screenshot: desktop-resume-browser.png — Resume Thread browser rendered on the desktop side. See DOCS_SITE_SHOT_LIST.md. -->
<!-- screenshot: messenger-resume-browser-telegram.png — Resume browser as it renders inside Telegram. Tracked at pwrdrvr/PwrAgent#345. -->

`/resume` (or `@PwrAgent resume`) opens the **thread browser** in the
current conversation. It paginates through your existing threads
with navigation buttons:

| Button | What it does |
|---|---|
| **1–8** | Bind this conversation to the numbered thread |
| **Projects** | Filter by project (the working directory the thread is rooted in) |
| **Next / Previous** | Page through the list |
| **New** | Switch to the [New Thread starter](#new-thread-starter) instead |
| **Cancel** | Dismiss without binding |

**Page size is 8 threads** on every supported platform. The browser
also accepts **text fallback** — reply `1` (or any digit through `8`)
to select a row without clicking a button, and `next`, `back`,
`projects`, `new`, `cancel` to navigate. Text and buttons are
equivalent.

You can pass arguments to `/resume` to narrow the list before the
browser opens:

```
/resume --projects             # open straight to project filter
/resume --new                  # equivalent to /new
/resume --fast --model claude  # pre-set Fast mode and model for the
                               # thread you pick (rolls forward into
                               # the Start Card)
```

Selecting a thread completes the binding and pins a **status card**
to the conversation showing the bound thread's current model,
reasoning, fast mode, and permissions.

<details markdown="1">
<summary>Per-provider exceptions</summary>

| Provider | Exception |
|---|---|
| All providers | None for page size — every supported platform has enough action budget to render 8-row pages plus the navigation row. |
| **Mattermost** | Text-fallback (`reply 1`) is the recommended path when the browser is rendered inside a channel thread on Mattermost v10.x — see [slash commands](#slash-commands-and-buttons). |

</details>

## New Thread starter {#new-thread-starter}

`/new` (or `@PwrAgent new`, or **New** from `/help`) opens a project
picker. Selecting a project advances to the [Start Card](#start-card-buttons)
where you set the thread's initial model, reasoning, fast mode, and
permissions before sending the first prompt.

Same pagination and text-fallback semantics as the Resume browser:
8 rows per page, button-or-reply-with-number, `next`/`back`/`cancel`.

If you only have one project configured, the picker is skipped and
you land on the Start Card directly.

## Start Card buttons {#start-card-buttons}

After picking a thread (or a project for a new thread), you see the
**Start Card** before the first prompt is sent. Four buttons let
you set the thread's initial state:

| Button | What you change |
|---|---|
| **Model** | The Codex model the thread will use (e.g., Claude Opus, Claude Sonnet, etc.) |
| **Reasoning** | Reasoning effort (Low, Medium, High) |
| **Fast: on / off** | Toggles Fast mode for the thread |
| **Permissions** | Cycles between Default Access and Full Access |

Each setting is **per-thread** in PwrAgent — unlike Codex Desktop,
where these are global. You can run a high-stakes refactor with
**Full Access** on a strong model while a low-stakes throwaway script
runs in **Default Access** on a cheaper model, and the two settings
don't bleed into each other.

**Defaults** come from the desktop's global Settings → Models page.
You can override per-thread here on the Start Card; the override
persists for the lifetime of the thread.

### A note on Permissions mid-turn

The Permissions cycle on the Start Card sets the thread's initial
mode. **Mid-turn** Permissions changes (changing access mode from the
bound-thread status card while the agent is working) **queue at the
turn boundary** rather than applying immediately. Don't expect a
mid-turn toggle to take effect on the in-flight request — Codex
finishes the current turn under the existing mode, then applies the
queued change before the next turn starts. The desktop shows a
"queued: Default → Full" pill on the composer while the change is
pending; the messenger surfaces an audit message in the bound
conversation when the queue applies. You can cancel a queued change
from either surface before it commits.

This is a separate queueing concept from the
[text-turn queue](#debounce-queue-steer) — the text-turn queue holds
*your follow-up messages*; the permission-mode queue holds *your
mode-change request*. Two different Cancel buttons; two different
audit-message lifecycles.

<details markdown="1">
<summary>Per-provider exceptions</summary>

Action-button budgets force per-provider label truncation when there
are many model rows. The headline pinch points:

| Provider | Action budget | Label cap |
|---|---|---|
| Discord | 25 | 80 chars |
| Telegram | 100 | 64 chars |
| Slack | 25 | 75 chars |
| Mattermost | 25 | **40 chars (tightest)** |
| Feishu / Lark | 20 | 20 chars |
| LINE | 13 | 20 chars |

Where labels run long (model names + reasoning levels combined),
**Mattermost and the two short-label providers (Feishu, LINE)
truncate hardest**. Lower-priority rows are dropped first to fit the
action budget; lowest-priority Model entries can drop entirely on
LINE.

If a label reads as ambiguous, text-reply with the row number does
the same thing as the button click.

</details>

## Sending the first prompt {#first-prompt}

After the Start Card, the **next message you send** in the bound
conversation is the **first prompt** for the new thread. The
binding completes, the thread starts, and the agent begins its first
turn against your message.

You don't need to click anything to "commit" the Start Card — sending
the first prompt does it implicitly. If you want to abandon the
Start Card without starting a thread, click **Cancel** from the help
menu or `/detach` (which is a no-op if nothing's bound yet but always
safe).

The binding-confirmation message the bot posts back includes the
chosen model, reasoning, fast mode, and permissions so you can verify
the Start Card state was captured correctly.

## Status card on a bound thread {#status-card-bound}

<!-- screenshot: desktop-status-card.png — Bound-thread status card on the desktop. See DOCS_SITE_SHOT_LIST.md. -->
<!-- screenshot: messenger-status-card-telegram.png — Status card as it renders inside Telegram. Tracked at pwrdrvr/PwrAgent#345. -->

After the binding completes, the **Start Card** evolves into the
**bound-thread status card**, pinned (or repeatedly posted, where the
platform doesn't support pinning) to the conversation. It carries the
same four state buttons as the Start Card plus four runtime controls:

| Button | What it does |
|---|---|
| **Model** | Cycle the thread's model |
| **Reasoning** | Cycle reasoning effort |
| **Fast: on / off** | Toggle Fast mode |
| **Permissions** | Cycle Default Access ↔ Full Access (mid-turn cycles queue — see [Start Card buttons](#start-card-buttons)) |
| **Tools: \<mode\>** | Cycle [tool-update verbosity](#tool-update-verbosity) |
| **Stream: \<mode\>** | Cycle streaming mode for this binding only — see [Streaming responses](streaming/) |
| **Skills** | Open the [skills browser](#skills-browser) to stage a Codex skill that gets prepended to your next prompt |
| **Refresh** | Re-render the card immediately |
| **Detach** | [Detach](#detaching-a-thread) this binding |

The card is the **single source of cross-surface state**. Change a
setting on the messenger and the desktop UI updates within
milliseconds; change it on the desktop and the card edits in place
on the messenger. There's no "out of sync" window to worry about.

`/status` from the conversation forces a refresh — useful if the
card scrolled out of view and your platform doesn't auto-pin (some
don't), or if you want a fresh card after a long quiet stretch.

## Skills browser {#skills-browser}

PwrAgent surfaces Codex skills from the bound conversation. The
**Skills** button on the [bound-thread status card](#status-card-bound)
opens a paged browser of the skills available on the thread:

1. Click **Skills** on the status card. The bot replies with a paged
   skill picker — same page-size / Next / Prev / Cancel mechanics as
   the [Resume Thread browser](#resume-thread-browser).
2. Either click the skill you want from the page, or click **Search**.
   With Search active, your next free-form reply to the bot becomes
   the skill query (no turn started); the browser re-renders showing
   the matches.
3. Click the skill row. PwrAgent posts a confirmation message showing
   the full `$skill` name plus available metadata — description,
   workspace, enabled status, skill path.

**Selecting a skill does not start a turn.** The skill is staged on
the binding. The **next free-form user message** you send becomes the
next turn with the staged skill **prepended once** to its input. The
staged skill survives across queueing — if your message gets held by
the [debounce / queue / steer](#debounce-queue-steer) state machine,
the prepend happens once when the turn finally runs.

What does **not** consume the staged skill (i.e. these are safe to do
between staging the skill and sending the real prompt):

- Commands (`/resume`, `/status`, `/detach`, `/help`, etc.)
- Browser-navigation clicks (Next, Prev, Cancel, Projects, etc.)
- Button callbacks on any surface
- Replies that match an active Search prompt (those re-query the
  browser instead)

To clear a staged skill before sending the prompt, click **Remove**
on the selection confirmation message.

The staged-skill state is **per-binding**. If a thread carries
multiple bindings (one Telegram, one Slack), each binding can have
its own staged skill independently; they don't bleed across.

## Tool-update verbosity {#tool-update-verbosity}

While the agent works, PwrAgent can post short progress messages
summarizing each completed tool call — `Read app.tsx`, `Ran build`,
`Searched src/components/`. These aren't agent-authored output;
they're machine-generated labels derived from the agent's tool
metadata. Raw command output, arguments that look secret, and diffs
are intentionally excluded.

The **`Tools: <mode>` button** on the status card cycles between
five verbosity modes:

| Mode | Behavior |
|---|---|
| **Show None** | Suppress generated tool-update messages entirely |
| **Show Less** | Batch all updates, flush every 60 seconds and at turn boundaries |
| **Show Some** *(default)* | Send up to three quiet updates individually, then batch every 30 seconds |
| **Show More** | Send up to five individually, then batch every 15 seconds |
| **Show All** | Send each tool update individually |

The default (**Show Some**) balances "you can see something is
happening" against eating the platform's write budget. Bump to
**Show More** or **Show All** if you want fine-grained visibility on
a thread that's doing significant tool work — but watch the
[rate-limits page](rate-limits/) if you're in a Telegram supergroup
or other tight-budget scope.

Each binding sets its own mode independently. The global default
lives in Settings → Messaging on the desktop; the status-card button
overrides per-binding.

Pending batches flush before assistant messages, approval prompts,
questionnaire prompts, status replies, and turn completion — so
tool-progress messages never arrive **after** the response they
explain.

## Typing indicators {#typing-indicators}

The bot shows a platform-typing indicator (the "…" / "typing" / hand-
in-message-area cue native to your platform) while a bound turn is
**actively waiting** on the agent.

The indicator stops when:

- The turn completes successfully.
- The turn fails or is interrupted.
- The turn hits an **approval prompt** or **questionnaire prompt** —
  Codex is waiting on you, so the typing indicator turns off to
  signal that you're now the bottleneck.

Intermediate assistant messages and tool-update progress
**don't** turn the indicator off — those are intermediate output,
not terminal lifecycle events. Typing resumes after you answer a
prompt until the next terminal event.

<details markdown="1">
<summary>Per-provider exceptions</summary>

| Provider | Exception |
|---|---|
| **Discord** | Discord's API has no "stop typing" call — the typing indicator is fire-and-forget and the platform auto-expires it on its own clock (roughly five seconds after the last typing event the bot sends). When a bound turn ends, the indicator can linger for several seconds before Discord clears it. PwrAgent can't shorten that tail. |
| **Feishu / Lark** | The Feishu / Lark messaging API does not surface bot typing indicators at all. The bot can't show a "thinking" cue while a turn runs on Feishu — you'll see the bot's reply when it arrives without any preceding activity hint. |

</details>

## Sending attachments {#attachments}

Bound conversations can send files and images into the active
thread. PwrAgent normalizes them and feeds them into the next turn
alongside any accompanying text.

| Accepted | Behavior |
|---|---|
| Text-like files (`.txt`, `.md`, `.csv`, `.json`, `.jsonl`, `.toml`, `.yaml`, `.yml`, logs, plain code) | Forwarded as text into the prompt |
| Images (PNG, JPEG, WebP) | Forwarded as image input |
| Animated GIFs | Converted to a **still image** (first frame) and forwarded as image input. Animation is not delivered to the model. |
| PDFs | Forwarded to the model as-is. PwrAgent does no text extraction or preprocessing — see [A note on PDFs](#a-note-on-pdfs). |

Rejected — with a short bot message explaining why, not silently:

- Audio and video files
- Archive files (`.zip`, `.tar`, etc.)
- Oversized files (above the configured `attachment_max_bytes` cap)
- Anything beyond the `attachment_max_count` per-turn cap

### A note on PDFs

PwrAgent forwards PDFs to the model **as-is** and lets the model
decide what to do with them. There's no in-app text extraction, no
OCR preprocessing, no page-rendering on PwrAgent's side.

What happens then depends on the model running the thread:

- **Modern Codex models** will often try to render the PDF pages to
  images and analyze the images themselves. Whether that works
  depends on the model and on the document's layout — multi-column
  layouts especially tend to confuse the model's page-analyze path.
- **Models without native PDF rendering** will either produce a
  worse result or refuse to use the document.

For any PDF you actually care about getting right, the most reliable
workflow is to **convert the relevant pages to PNG or JPEG yourself
first** and send those as image attachments. You control which
pages get sent, the result is predictable across models, and the
model sees exactly what you intended.

### Image upload profile

PwrAgent has a per-config **image upload profile** that controls
how inbound images are normalized before being forwarded to the
model: `low`, `medium` *(default — matches desktop paste behavior)*,
`high`, or `actual`. Set it from **Settings → Messaging** in the
desktop. The same value can also be written directly under
`[messaging]` in `~/.pwragent/profiles/<name>/config.toml` as
`attachment_image_profile`, or via the
`PWRAGNT_MESSAGING_ATTACHMENT_IMAGE_PROFILE` environment variable —
useful for headless / scripted setups.

Default (`medium`) is appropriate for the vast majority of uses;
the other values exist for when you specifically need to trade
bandwidth against fidelity.

### Debounce ordering

Attachments are processed **before** they enter the
[debounce / queue / steer](#debounce-queue-steer) state machine, so
a file plus a follow-up text message inside the debounce window
land in the same turn as a multi-part prompt.

## Debounce, queue, and steer {#debounce-queue-steer}

PwrAgent's text-turn queueing exists for two situations:

### Situation 1: you split a single thought across multiple messages

Some platforms (especially mobile clients) break long messages into
two or three separate sends. PwrAgent waits **500 ms** after each
message before starting a turn, so a follow-up that arrives within
that window joins the same turn rather than starting a second.

This **debounce window** is configurable via the
`input_debounce_ms` setting in Settings → Messaging → \<platform\>
or in `config.toml`. Increase if you tend to send multi-part messages
over a few seconds; set to `0` to disable the wait entirely (useful
when you want every send to be a fresh turn).

### Situation 2: you send a message while the agent is mid-turn

If a follow-up arrives while a bound thread already has an **active
turn**, PwrAgent doesn't drop it. The bot acknowledges with a
**queued-turn notice** in the conversation: a quoted preview of your
message (truncated to 500 chars) plus two buttons:

| Button | Behavior |
|---|---|
| **Steer** | Inject the queued message into the current turn — Codex sees it as additional context before completing |
| **Cancel** | Drop the queued message; it won't be submitted |

If you click neither and the active turn finishes, the queued
message becomes the **next turn** automatically (FIFO order if you
queue several).

**Steer is only available when the active turn is in a steerable
state** — typically `working` or `waiting` with the backend
indicating it accepts mid-turn input. If Steer is grayed out, the
turn isn't accepting steers; you can still Cancel or wait for it to
finish.

The notice card edits in place when you act on it — the buttons clear
once the queued message is steered, cancelled, or submitted as the
next turn. The desktop's transcript shows queued-turn entries in the
same temporal order they arrived.

<details markdown="1">
<summary>Per-provider exceptions</summary>

| Provider | Exception |
|---|---|
| **LINE** | LINE doesn't support message edits, so the queued-turn notice posts a **fresh message** every time its state changes (queued → steered, queued → cancelled, queued → submitted). On every other platform the same notice card edits in place. |

</details>

### Not the same as the permission-mode queue

The text-turn queue documented in this section is for **your text
messages**. There's a separate **permission-mode queue** for
*mid-turn access-mode changes* (Default ↔ Full Access) — those queue
at the turn boundary and apply between turns, not mid-turn. See
[Start Card buttons](#start-card-buttons) for the permission-mode
queue beat. Two distinct queueing surfaces; don't conflate them.

## Monitor cards {#monitor-card}

`/monitor` (or `@PwrAgent monitor`) **binds the current conversation
as a monitor surface** and posts a dashboard card that's refreshed
periodically. The card shows **your pinned and recent PwrAgent
threads** across the workspace — not items inside any one thread.
It lets you see what's running and what's been active without being
at the desktop.

> **A monitor binding is a binding.** A messaging conversation can
> host **either** a thread binding (typical — the conversation
> drives that one Codex thread) **or** a monitor binding (the
> conversation shows the workspace dashboard). Not both at the same
> time. Running `/monitor` in a conversation that's currently bound
> to a thread replaces the thread binding with the monitor binding —
> the thread itself keeps running on the desktop, but that
> conversation no longer drives it.
>
> **Dedicate a separate surface for the monitor** so you can
> actually see it. Good options:
>
> - A **specific topic in a Telegram supergroup** that you don't
>   use for thread work.
> - A **dedicated Telegram DM** (e.g., a second bot, or saved
>   messages with a dedicated bot account).
> - A **dedicated Discord channel** or DM thread.
> - Any **quiet, low-traffic surface** where the refresh ticks
>   won't compete with active conversation.

- **Pinned threads** — your pinned threads. Default 5; can cycle to
  0 (hide the section) or 10.
- **Recent threads** — your most-recently-active threads. Default
  5; can cycle to 0 or 10.
- **Snippet line** — optional ~100-character preview of each
  thread's latest response. Toggle on or off; default on.
- A **button row** to adjust the card live.

The monitor refreshes every **60 seconds by default** on platforms
that support message edits (everywhere except LINE). The card edits
in place at each tick — the timestamp updates, snippets refresh,
the thread order reflows as pins or recent activity change on the
desktop.

| Button | What it changes |
|---|---|
| **Interval** | Cycle through `10s` → `30s` → `60s` → `5m` (default 60s) |
| **Pins** | Cycle pinned-thread count: `0` → `5` → `10` (default 5) |
| **Recent** | Cycle recent-thread count: `0` → `5` → `10` (default 5) |
| **Snippet** | Toggle the per-thread response snippet on / off (default on; fixed ~100-character preview when on) |
| **Refresh** | Re-render right now |
| **Stop** | Convert the monitor binding back to a regular conversation (no binding) |

Running `/monitor` in a conversation that already has a monitor
binding refreshes the existing card rather than posting a duplicate.
Each monitor-bound conversation hosts exactly one monitor card.

The monitor binding survives PwrAgent restarts — on startup, every
monitor-bound conversation resumes its refresh ticks automatically.
The set of threads the card shows is derived live from your desktop
state, so archiving a thread on the desktop simply removes it from
the pinned/recent rows on the next refresh; archiving doesn't
detach the monitor binding itself.

To switch a monitor surface back to a regular conversation, click
**Stop** on the monitor card or send `/detach` from the same
conversation. From there you can `/resume` to bind it to a thread,
or leave it unbound.

<details markdown="1">
<summary>Per-provider exceptions</summary>

| Provider | Exception |
|---|---|
| **LINE** | LINE doesn't support message edits, so the monitor card posts a **fresh card** at every tick instead of editing in place. Combined with a 60-second default interval, this means a new card every minute. Consider increasing the interval to `5m` on LINE (via the **Interval** button) to keep the conversation readable. |

</details>

## Detaching a thread {#detaching-a-thread}

`/detach` (or `@PwrAgent detach`, or **Detach** on the status card)
unbinds the current conversation from the thread. The thread itself
keeps running on the desktop; only the binding is severed.

What happens when you detach:

1. Any active turn is interrupted cleanly (the turn marks as
   interrupted in the transcript).
2. Pending tool-update batches flush.
3. Any monitor card on this binding stops.
4. The status card is retired — its buttons stop responding.
5. A "Thread detached" confirmation posts in the conversation.
6. The desktop's binding chip for that thread disappears.

You can re-bind the same conversation to any thread later by sending
`/resume`. The conversation falls back to the help menu on the next
message after detach, so you'll see Resume / New buttons there.

The same single detach pipeline runs whether you detach from the
conversation (`/detach`), from the status card (**Detach** button),
or from the desktop (right-click "Unbind" on the binding chip). The
behavior is identical across all entry points and across all
platforms.

## Archiving a thread {#archiving-a-thread}

Archiving a thread in the desktop **automatically detaches all of
its bindings**. If the thread had one Telegram binding and one Slack
binding, both detach.

The detach uses the [same pipeline](#detaching-a-thread) as
`/detach` — same interrupt, same flush, same status-card retirement,
same "Thread detached" notice in each bound conversation. No
per-provider code paths.

You don't need to detach manually before archiving. Just archive.

If you un-archive a thread, its bindings are **not** restored
automatically — you'll need to send `/resume` from each conversation
you want to re-bind. The previous binding state is gone.

---

## See also

- [Providers](providers/) — per-platform setup and Settings reference.
- [Rate limits and budgets](rate-limits/) — per-platform write
  budgets, Slow Mode priority order, and label caps.
- [Streaming responses](streaming/) — why the toggle is off by
  default and stays off in most setups.
- [Webhooks — a security note](webhook-dangers/) — only relevant
  for Mattermost and LINE (the two HTTP-callback platforms).
