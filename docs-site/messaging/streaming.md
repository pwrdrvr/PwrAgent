---
layout: page
title: Streaming responses
---

# Streaming responses: why you probably don't want them

The **Streaming Responses** toggle in Settings → Messaging → \<platform\>
sounds great. The word "streaming" calls up "live", "responsive", "you
can watch the agent think." That's not what it does. Read this before
you flip it.

## What you think it does

You think you'll get a series of messages as the agent works — one for
the start of the answer, one for each tool the agent runs, one for the
final wrap-up — letting you follow along in chronological order, the
way you might watch a person write.

## What it actually does

The bot posts **one** message at the start of the response. As the
agent produces text, the bot **edits that same message** to extend it.
By the end of the turn, you have a single message that contains the
whole reply, but it was repeatedly rewritten on its way there.

You don't get a message per tool call. You don't get a paragraph at
a time as the agent thinks. You get **one message, edited many times**.

## Why that's worse than it sounds

### 1. Voice readers only hear the first version

Screen readers and voice assistants (Siri's "Announce Notifications,"
Apple Watch, VoiceOver, Android TalkBack, in-car voice readers) read a
message **when it first arrives**. They don't observe subsequent edits
to the same message.

So if streaming is on and the bot posts this sequence:

| Time | Message body |
|---|---|
| 0:00 | `I will ` |
| 0:01 | `I will explore the files ` |
| 0:02 | `I will explore the files in this directory to look for the widget component that you mentioned.` |

Siri reads to you: ***"I will."*** And stops. Streaming is off, the
same response is delivered as one final message, and Siri reads the
whole thing.

For anyone who consumes the bot via voice — driving, walking,
multi-tasking, accessibility need — streaming actively breaks the
product.

### 2. Each edit eats rate-limit budget

Edits are not free. On most platforms, an edit is its own API request
and counts against the same write budget as a new message.

Telegram's measured limits (from May 2026 probes by the PwrAgent
team):

| Surface | Practical write budget |
|---|---|
| Telegram DM | ~60 messages/edits per minute |
| Telegram supergroup | ~20 messages/edits per minute (shared across all topics) |

A single streamed response can easily produce 5–10 edits. The example
sequence above is 3 messages out of a 20/minute supergroup budget
spent on a single response.

| Platform | Behavior |
|---|---|
| Telegram | Sends and edits share one supergroup budget. Edit calls return 429 with `retry_after` when the budget runs out. |
| Slack | Edits are more permissive than sends (`chat.postMessage` has its own limit), but they still count as API requests. |
| Discord | Edits are permissive but still hit route/global REST buckets. |
| Mattermost | Server-configured. |

When the budget runs out, PwrAgent enters Slow Mode and starts dropping
non-final streaming edits to preserve the final message and interactive
prompts. The rate-limit pain doesn't bite mid-turn; it bites the **next
few turns**, which run with degraded surfaces because the budget hasn't
recovered.

### 3. You don't get tool-by-tool visibility

If your goal is "see what the agent is doing as it works," the right
surface is **tool update notifications**, not streaming. Tool updates
are separate messages — one per completed tool call (or batched, per
your verbosity setting) — that summarize what the agent did. They
survive voice readers, they're rate-limit-aware, and they're on by
default at `Show Some`.

See the per-platform "Settings reference" for the `Tools: <mode>` toggle.

## When you might actually want streaming on

A small set of cases where streaming is the right call:

- **You're sitting in front of a desktop chat client**, watching the
  message render.
- **You're not using a voice reader.**
- **The conversation is a private DM with no other concurrent traffic**
  (rate-limit pressure is low).
- **The response is long enough that the edit-by-edit rendering
  actually gives you useful early-information**, rather than just a
  half-formed first sentence.
- **You don't have a per-binding `Tools` mode set to a verbose value**
  (or you don't care about tool visibility).

In every other case — the default desktop user, anyone using the bot
hands-free, anyone routing through a supergroup with other activity —
streaming is a net negative.

## Defaults and how to change them

- The provider-level toggle in Settings → Messaging → \<platform\> →
  Streaming Responses is **off** by default. Leave it off unless one of
  the cases above applies.
- A single binding can opt in or out of streaming independently. The
  status card's `Stream: <mode>` button cycles through
  `Default` → `On` → `Off`.
  - `Default` follows the provider-level toggle.
  - `On` enables streaming for this binding only.
  - `Off` disables streaming for this binding only.

If you're not sure: leave the toggle off, run a few turns, then decide
whether the cost-of-edits and voice-reader breakage are worth the
live-rendering you'd be trading them for. Usually they're not.

## See also

- [Messaging concepts overview](overview.md) — tool updates, Slow
  Mode, attachments, the rest of the per-binding state.
- The per-platform pages cover where exactly the Streaming Responses
  toggle lives in each Settings panel.
