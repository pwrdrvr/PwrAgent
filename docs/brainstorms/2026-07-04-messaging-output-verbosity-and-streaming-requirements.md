---
title: Messaging output verbosity, coalescing, and streaming — concepts and requirements
type: requirements
status: draft
date: 2026-07-04
tags: [messaging, telegram, discord, tool-updates, streaming, rate-budget, coalescing, elicitation]
related_code:
  - packages/shared/src/contracts/messaging.ts
  - packages/messaging/interface/src/index.ts
  - apps/desktop/src/main/messaging/core/messaging-tool-update-policy.ts
  - apps/desktop/src/main/messaging/core/messaging-delivery-budget.ts
  - apps/desktop/src/main/messaging/core/messaging-controller.ts
  - apps/desktop/src/main/messaging/core/messaging-status-card.ts
  - apps/desktop/src/main/messaging/core/messaging-resume-browser.ts
---

# Messaging output verbosity, coalescing, and streaming

> **Why this doc exists.** The messaging bridge has four different kinds of
> agent output and (at least) three overlapping controls governing what
> reaches the phone. The terminology has drifted — "tool updates,"
> "streaming," "in-turn messages," and "rate budget" get conflated, and even
> careful readers (human and agent) mix them up. This doc pins down what each
> thing *is*, what's wrong today, and the decisions we've made for the next
> iteration. It is a concept reference first and a requirements list second.

## The four output streams (glossary)

Everything the agent emits during a turn falls into exactly one of these
structural categories. This taxonomy is *structural* on purpose — we do not
try to judge whether a given line of prose is "important." We can't do that
reliably, so we classify by shape, not by meaning.

| # | Stream | What it is | Reader's mental bucket |
|---|--------|-----------|------------------------|
| 1 | **Tool activity** | `item/completed` events for tool / command / MCP / file / search items. "Read X", "ran `git status`", "edited Y". | "the agent working" |
| 2 | **In-turn (intermediate) prose** | *Completed* assistant text blocks emitted mid-turn, before the final answer. The agent thinking out loud ("Let me check the config…", "I found the issue in…"). | "the agent working" |
| 3 | **Final response** | The terminal assistant message for the turn — the actual answer. | "the answer" |
| 4 | **Elicitation / questionnaire** | A structured, *blocking* prompt: approval, confirmation, questionnaire. The run stalls until it's answered. | "it needs me" |

The key reader-side insight: **streams 1 and 2 are the same thing to the
person on their phone** — both are "the agent working." Streams 3 and 4 are
"the answer" and "it needs me." That collapse is what drives the single-dial
decision below.

## The controls today (and what's wrong with each)

### `toolUpdateMode` — the Activity dial (governs stream 1 only)

- Values: `show_none`, `show_less`, `show_some`, `show_more`, `show_all`
  ([packages/shared/src/contracts/messaging.ts](../../packages/shared/src/contracts/messaging.ts)).
- A real graduated dial with batching windows: `show_all` sends individually;
  `show_more` up to 5 individual then batch (15s window); `show_some` up to 3
  then batch (30s); `show_less` always batch (60s); `show_none` never
  ([messaging-tool-update-policy.ts](../../apps/desktop/src/main/messaging/core/messaging-tool-update-policy.ts)).
- Per-binding override with a global default fallback
  (`MessagingBindingPreferences.toolUpdateMode`,
  `resolveMessagingToolUpdateMode`).
- **Problem 1:** it governs *tool activity only*. Stream 2 (in-turn prose) is
  not on this dial at all.
- **Problem 2:** it is **not settable in the `/new` wizard** — only after the
  thread/binding exists, via the status card.

### `streamingResponses` — the misnamed trap (partially governs stream 2)

- Values: `inherit`, `enabled`, `disabled`.
- **What operators think it means:** whether the bot sends in-turn messages.
  **Wrong.**
- **What it actually means:** whether a *single bridged message* gets
  progressively **edited/replaced** as tokens arrive from the agent. It is a
  *messaging-only, message-edit* behavior.
- **It does NOT control desktop streaming.** Responses always stream inside
  the desktop app regardless of this setting. This only affects the messaging
  bridge.
- **It is a rate-limit trap.** Every message edit counts as a *send* against
  the provider's rate limit. Telegram allows roughly **20 msgs/min in a
  group** and **60 msgs/min in a DM**; token-by-token editing blows through
  that in a few seconds. The result: you get a few early tokens, then
  everything throttles — and because throttling drops low-priority traffic,
  it *also* kills your tool and status updates.
- Today, in-turn prose is only surfaced when `streamingResponses` is
  `enabled`, which couples "do I see narration at all" to "do I want
  token-by-token editing." Those are different questions.
- **Consensus: most people do NOT want this on. It is a poor experience and
  should be treated as an advanced escape hatch, off by default.**

### Rate budget — the final gate

- [messaging-delivery-budget.ts](../../apps/desktop/src/main/messaging/core/messaging-delivery-budget.ts):
  default sliding window 60 messages / 60s, 1 reserved slot, 2s safety buffer,
  slow-mode floor 5s, slow-mode recovery 5min after a 429 cool-off.
- Priority tiers: `critical_interactive` (elicitations) and `final_turn`
  (final answers) are deferrable but never dropped; `routine_status`,
  `tool_progress`, and `stream_partial` are dropped in slow mode.
- **Consequence:** even `show_all` is not literally "all" — the budget can and
  will hold progress back. Any user-facing copy must set that expectation.

## Decisions

### D1 — One dial for streams 1 + 2 ("Activity updates")

Rescope and rename `toolUpdateMode` so it governs **tool activity *and*
in-turn prose** as one blended, coalesced stream. Rename the surface from
"Tool usage notifications" to **"Activity updates"** (or "Working updates").

- **None** — only final answers + elicitations. In-turn prose and tool
  activity are suppressed. *(This is the "agent personality" mode that is
  impossible to express today.)*
- **Less / Some / More** — increasing density of **coalesced** progress
  (tools + prose blended, batched).
- **All** — the most, still subject to the rate budget.

"Intermediate prose" surfaced by this dial means *completed* mid-turn
assistant messages, coalesced — **not** live token deltas. It works with
streaming **off** (the normal case).

Route stream 2 through the **same** `MessagingToolUpdatePolicy` that already
batches stream 1, so both share one coalescing buffer and one budget lane.

**Rationale for one dial, not two:** to the reader, tools and narration are
the same "progress" bucket, and the motivating personality-thread case wants
both gone together (= one dial at its floor, not two dials turned down).
One → two is a cheap future move (ship an "unlink" advanced toggle if evidence
ever demands it); two → one is a migration. Build the widenable thing.

### D2 — Elicitations and final responses are never on the dial

Streams 3 and 4 always send (`final_turn` / `critical_interactive`,
deferrable-but-never-dropped). The dial only governs the *optional* progress
stream, which is why **None is safe** — it can never starve or stall a run.

### D3 — Streaming becomes a gated, default-off advanced feature (Option 4)

Do **not** fold streaming into the Activity dial. Keep it a separate concept
and hide it by default behind a single global **Messaging → "Show streaming
option on thread cards"** setting, default **Off**, with an advisory note.

- Rejected: the "hide unless a provider has streaming enabled" heuristic —
  it keys off an unrelated concern and fires backwards (streaming here is
  messaging-only; it has nothing to do with provider/desktop streaming).
- Rejected: full removal — orphans anyone who already has it enabled, with no
  card control to turn it back off.
- Rejected: per-card "Advanced ▸" disclosure — too heavy for one row.
- **Safety rule:** show the per-thread streaming control if the global setting
  is On **OR** any binding currently has streaming enabled, so nobody who
  already flipped it on gets stranded.

### D4 — A questionnaire must carry its preceding in-turn message

When we surface an elicitation/questionnaire, the agent has often described
the options in the *preceding in-turn message* ("So which do you want — Option
A or Option B?") while the elicitation prompt itself is terse. **If that
preceding in-turn message has not already been sent** (e.g. because the
Activity dial suppressed or was still coalescing it), send it immediately
*before* the elicitation so the question has its context. Elicitation delivery
must flush any pending buffered prose that belongs to the same turn.

### D5 — Coalescing with exponential backoff (streaming AND slow mode)

This is spun off to its own worktree (see below) but is captured here because
it's part of the same conceptual model.

- Streaming must **not** emit one edit per agent delta. Debounce per in-flight
  message using a stored **"next allowed release time"**, not a proliferation
  of timers: on each incoming delta, if the timestamp hasn't passed and the
  message isn't final, **coalesce** (buffer) instead of sending.
- Backoff schedule for a single message: wait ~**250–500ms** after first
  receipt, send a coalesced block; then **1s**, **2s**, **4s**, **8s**, up to
  a **~16s cap** between edits. The **final** message flushes immediately
  (bypasses the timer).
- Apply the same coalescing to **non-streaming** updates whenever **slow mode**
  is active. We don't do any of this today.

## Explanatory copy

**Activity dial editor (picker header):**

> Controls how much of the agent's in-progress work is bridged here.
> **None** — only final answers and questions. Intermediate "thinking out
> loud" messages and tool activity are suppressed.
> **Some / More** — those get coalesced into occasional batched updates to
> stay under platform rate limits.
> **All** — sends the most, though the rate budget may still hold some back.

**Streaming toggle (advisory):**

> **Advanced.** This does **not** control whether the bot sends in-turn
> messages — it controls whether a single message is repeatedly edited /
> replaced as tokens come in. Each edit counts as a message send, so it burns
> through platform rate limits fast (≈20/min in groups, ≈60/min in DMs) and
> usually ends up throttled — which then slows or drops your tool and status
> updates too. You may see slightly earlier tokens, but most people should
> leave this **off**.

## Requirements checklist

- [ ] Rename/rescope `toolUpdateMode` → "Activity updates"; None suppresses,
      Less/Some/More coalesce, All = most. (D1)
- [ ] Feed in-turn prose (stream 2) into `MessagingToolUpdatePolicy` so tools
      and prose share one coalescing buffer / budget lane. (D1)
- [ ] Decouple in-turn prose visibility from `streamingResponses`. (D1/D3)
- [ ] Add the Activity dial to the `/new` wizard picker sequence in
      [messaging-resume-browser.ts](../../apps/desktop/src/main/messaging/core/messaging-resume-browser.ts);
      collect into the preferences already passed to `updateBindingPreferences`
      at thread creation. Infra (per-binding override + global fallback)
      already exists — this is a picker + one collected field. (Concern A)
- [ ] Add global Messaging setting "Show streaming option on thread cards"
      (default Off) gating the per-thread streaming control, with the
      "OR any binding has it enabled" safety rule. (D3)
- [ ] Attach the two explanatory notes to the respective editors.
- [ ] Flush the preceding in-turn message before an elicitation if unsent. (D4)
- [ ] **[separate worktree]** Streaming/slow-mode coalescing with exponential
      backoff via next-release timestamps. (D5)

## Open questions / deferrals

- Exact label: "Activity updates" vs "Working updates" vs "Progress." TBD.
- Whether `show_less` vs `show_some` vs `show_more` thresholds need retuning
  now that prose shares the buffer (more content per window).
- Migration for existing bindings with `streamingResponses: enabled` once the
  card control is hidden by default (the safety rule covers discoverability;
  no data migration needed).

## Code map

See the file list in frontmatter. Entry points:
`toolUpdateMode` enum → `messaging.ts`; batching policy →
`messaging-tool-update-policy.ts`; budget/slow-mode →
`messaging-delivery-budget.ts`; delivery-priority routing + stream buffering →
`messaging-controller.ts`; status-card pickers → `messaging-status-card.ts`;
`/new` wizard sequence → `messaging-resume-browser.ts`.
