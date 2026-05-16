---
layout: page
title: Streaming responses
redirect_from:
  - /messaging/streaming/
  - /messaging/streaming
---

# Streaming responses: why you probably don't want them

The **Streaming Responses** toggle in Settings → Messaging → \<platform\>
sounds great. The word "streaming" calls up "live", "responsive", "you
can watch the agent think." That's not what it does. Read this before
you flip it.

## What you think it does

You think enabling streaming makes the agent's response arrive faster,
or that streaming is the thing that breaks a long reply into smaller
messages you can watch arrive piece by piece.

## What it actually does

Streaming does not change how *many* messages you get per turn. A
single agent turn typically produces a handful to a dozen separate bot
messages already — each assistant text emission, the tool-progress
summaries ("Read app.tsx", "Ran build"), the turn-completion summary
at the end. Those are separate messages regardless of streaming;
they're driven by the agent's own tool calls and your `Tools: <mode>`
verbosity setting.

What streaming changes is how **each** of those bot messages arrives:

- **With streaming off:** the bot waits until one of those emissions
  is complete, then posts it as a single message.
- **With streaming on:** the bot posts a partial version of the
  message early and edits it two or three times as more text arrives,
  until it reaches the final form.

So streaming doesn't take you from 10 messages per turn down to 1. It
gives you the same ~10 messages, each with 2–3 extra edits while they
finalize.

## Why those extra edits are usually a bad trade

Two follow-on effects from the edits:

### 1. Voice readers only hear the first version of each message

Screen readers and voice assistants (Siri's "Announce Notifications",
Apple Watch, VoiceOver, Android TalkBack, in-car voice readers) read a
message **when it first arrives**. They don't re-read it as the bot
edits.

So if streaming is on and one of the bot's messages goes through this
sequence:

| Time | Message body |
|---|---|
| 0:00 | `I will ` |
| 0:01 | `I will explore the files ` |
| 0:02 | `I will explore the files in this directory to look for the widget component that you mentioned.` |

Siri reads to you: ***"I will."*** And stops. Streaming off, the same
emission arrives as one message and Siri reads the whole thing. For
anyone consuming the bot via voice — driving, walking, multi-tasking,
accessibility need — streaming actively breaks the product.

### 2. Each edit eats rate-limit budget — and gets auto-disabled when budgets tighten

Edits are not free. On most platforms an edit is its own API request
and counts against the same write budget as a new message.

A turn with ~10 bot messages and 2–3 edits per message is ~30 budget
consumptions in the span of a single response. PwrAgent's local Slow
Mode is designed to keep **critical** traffic flowing under tight
budgets — approval prompts, the final assistant text, the turn
completion summary. Streaming edits are the **least critical** thing
the adapter sends, so they're the first thing Slow Mode starts
dropping. In practice, on any turn with serious tool activity you may
turn streaming on and watch PwrAgent auto-disable it part-way through
the turn.

For the per-platform measured budgets and the full edit-support
matrix, see [Rate limits and budgets](/rate-limits/). Headline numbers:
Telegram DMs allow ~60 messages+edits/min; Telegram supergroups allow
~20 shared across all topics; Slack and Discord are more permissive
on edits; LINE doesn't support edits at all, so the streaming toggle
is a no-op there.

## When streaming might actually be the right call

A narrow case: you know the turn will produce **exactly one** bot
message (no tool calls, no skill use, no tool-update chatter), the
**very start** of that message contains the information you actually
care about, the rest doesn't, **and** you can't get the bot to shape
the response any other way (split into chunks, lead with a summary,
etc.). If you're sitting in front of a desktop chat client watching
that single message render character by character is faster-feeling
than waiting for the final blob.

That's the case streaming was built for. For everything else — any
turn that touches tools or skills, anything routed to a phone, anyone
using voice, anyone in a supergroup with other activity — streaming is
a net negative, and often one PwrAgent will quietly disable on you
mid-turn anyway.

## Defaults and how to change them

- The provider-level toggle in Settings → Messaging → \<platform\> →
  Streaming Responses is **off** by default. Leave it off unless your
  use fits the narrow case above.
- A single binding can opt in or out of streaming independently. The
  status card's `Stream: <mode>` button cycles through
  `Default` → `On` → `Off`.
  - `Default` follows the provider-level toggle.
  - `On` enables streaming for this binding only.
  - `Off` disables streaming for this binding only.

If you're not sure: leave the toggle off, run a few turns, watch how
many separate messages a representative turn produces, then decide
whether the character-by-character rendering on a few of them is worth
the edits.

## See also

- [Using Codex via Messaging](/using-codex/) — tool updates, Slow
  Mode, attachments, the rest of the per-binding state.
- The per-platform pages cover where exactly the Streaming Responses
  toggle lives in each Settings panel.
