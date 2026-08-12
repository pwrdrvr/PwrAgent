---
title: "feat: Slack Live Working Cards for Working Updates"
type: feat
status: planned
date: 2026-08-12
origin: handoff research from Linear Slack live-card signal
sources:
  - https://x.com/linear/status/2087277719130165435
  - https://docs.slack.dev/ai/developing-agents
  - https://docs.slack.dev/changelog/2026/02/11/task-cards-plan-blocks
  - https://slack.dev/slack-thinking-steps-ai-agents/
  - https://docs.slack.dev/reference/block-kit/blocks/task-card-block
  - https://docs.slack.dev/reference/block-kit/blocks/plan-block
  - https://docs.slack.dev/reference/methods/chat.startStream
  - https://docs.slack.dev/reference/methods/chat.appendStream
  - https://docs.slack.dev/reference/methods/assistant.threads.setStatus
  - docs/plans/2026-07-04-001-feat-messaging-working-updates-dial-plan.md
  - docs/plans/2026-05-02-001-feat-messaging-tool-update-verbosity-plan.md
---

# feat: Slack Live Working Cards for Working Updates

## Summary

Linear's 2026-08-11 product post demonstrates **live cards in Slack** for agent
coding sessions: operators follow investigation/tool steps in place, then open
a review/diff when the agent is ready. Linear's public Slack docs still
describe issue filing and unfurls; they do **not** document the card protocol.
The implementable Slack surface is Slack's own **Thinking Steps** stack:

1. **Chat Streaming** — `chat.startStream` / `chat.appendStream` / `chat.stopStream`
2. **Task cards** — Block Kit `task_card` (+ `plan` container)
3. **Task display mode** — `timeline` | `plan` | `dense` on stream start
4. **Thread status shimmer** — `assistant.threads.setStatus` (already used)

PwrAgent should map **Working Updates** onto that stack for Slack only, without
changing the dial semantics (None / Few / Some / More / All) or flooding other
providers.

This note is research + design. Product code ships in a follow-up implementation
thread/PR.

## Signal analysis (what Linear showed)

| Claim from Linear post | What we can verify from primary sources |
| --- | --- |
| "Live cards in Slack" for coding sessions | Product marketing language; not a separate Slack product API named "Live Cards" |
| Follow agent investigation + changes in Slack | Matches Slack Thinking Steps: streamed `task_update` / `task_card` with statuses |
| Open diff from Slack when ready for review | Action buttons / links on final message (existing PwrAgent status/PR surfaces can cover) |

**Do not reverse-engineer Linear's private payload.** Build on Slack's published
APIs and PwrAgent's existing Working Updates controller.

## Slack platform facts (constraints)

### Streaming + Thinking Steps

- Start: `chat.startStream` (scope `chat:write`, Tier 2 ≈ 20+/min)
- Append: `chat.appendStream` (Tier 4 ≈ 100+/min) — good for frequent task ticks
- Stop: `chat.stopStream`
- Streamed messages **must** be thread replies (`thread_ts` required)
- Channel streams require `recipient_user_id` + `recipient_team_id`
- Chunk types: `markdown_text`, `task_update`, `plan_update`, `blocks`
- `task_update` / `plan_update` title/details are limited (**256 chars**)
- Blocks may be finalized on stop; unfurling disabled on streaming messages
- Task display modes:
  - `timeline` — sequential tasks as they happen
  - `plan` — grouped task list (collapsed by default)
  - `dense` — collapse consecutive tool calls into summarized cards

### Task card model

`task_card` fields (from Slack Block Kit):

| Field | Notes |
| --- | --- |
| `task_id` | Stable id for update-in-place |
| `title` | Plain text |
| `status` | `pending` \| `in_progress` \| `complete` \| `error` |
| `details` / `output` | Optional rich_text |
| `sources` | Optional URL source elements |

`plan` groups multiple task cards under a title.

### Status shimmer

`assistant.threads.setStatus` shows "is working…" next to the bot. PwrAgent
already maps `activity: typing` → this API when thread_ts is known. Clear with
empty status. Needs Agents feature / `assistant:write` or compatible `chat:write`
path; adapter already degrades when unsupported.

### Message edits outside streaming

Slack agent guidance: for longer messages, call `chat.update` **at most once
every 3 seconds**. Prefer streaming APIs for live work; reserve `chat.update`
for non-stream fallbacks and final polish.

### Visibility / privacy

- Stream content is ordinary channel/DM message visibility (not ephemeral).
- In public channels, Working Updates are visible to everyone in the channel.
- Do **not** put secrets, raw command output, env values, or private reply
  content into task titles/details (existing controller redaction rules).
- Prefer basenames / safe titles already produced by
  `messaging-tool-activity.ts`.

### Accessibility

- Task cards are collapsed by default in plan/timeline modes; provide a
  plain-text `fallbackText` / top-level message text so screen readers and
  notification previews still get a one-line status.
- Status shimmer is supplementary, not a substitute for a durable final answer.
- Voice readers may miss mid-stream edits; final assistant message remains
  authoritative (same rule as existing streaming responses).

### Install / scopes

| Capability | Scope / feature |
| --- | --- |
| Stream + post/update | `chat:write` (already required) |
| Agent status / suggested prompts | Agents feature → `assistant:write` |
| SDK floor | Node Slack SDK ≥ 7.14.0 (repo has `@slack/web-api` ^7.15.2) |

No new marketplace capability is strictly required for `chat.*Stream` beyond
`chat:write`, but Agents feature remains needed for the shimmer status path
PwrAgent already uses.

## Current PwrAgent state

### Working Updates (controller)

- Dial modes: `show_none` | `show_less` | `show_some` | `show_more` | `show_all`
  (labels None / Few / Some / More / All)
- Policy: `MessagingToolUpdatePolicy` batches by binding+turn
- Sources: completed tool items + in-turn assistant prose
- Delivery: **new `message` intents** per individual/batch (not a single live card)
- Final answers / approvals / questionnaires are **not** gated by the dial
- Cancellation + rate budget + Slow Mode already drop stale low-priority traffic

### Slack adapter today

| Intent | Behavior |
| --- | --- |
| `activity` typing | `assistant.threads.setStatus` |
| `stream_update` | `chat.postMessage` then `chat.update` (not native streams) |
| tool Working Updates | ordinary `message` posts ("Tool update: …") |
| status card | Block Kit actions / pinned-style status message |

**Gap:** Slack posts many small system messages for Working Updates instead of
one updating Thinking Steps card, so the Linear-like live-card UX is missing
even though the dial and tool summaries already exist.

## Goals / non-goals

### Goals

1. Slack bindings render Working Updates as **one live stream card per turn**
   (Thinking Steps), updating in place.
2. Preserve dial semantics and budgets; None stays silent; All is densest.
3. Map turn UX states: queued → working → waiting → completed / failed.
4. Keep controller channel-agnostic; Slack owns native rendering; other
   providers keep text Working Updates.
5. Fail closed on privacy (redacted titles only) and degrade gracefully when
   stream APIs/status are unavailable.

### Non-goals (v1)

- Recreating Linear's exact product UI or private protocols
- Enabling native `chat.*Stream` for full assistant answer streaming (separate
  from Working Updates; can share plumbing later)
- Cross-provider live cards
- Streaming raw tool stdout into Slack
- Marketplace Agent-view migration as a hard dependency for Working Updates
- Changing persisted preference keys

## Recommended architecture (smallest coherent path)

### Principle

**Controller still decides *whether* and *what* to surface. Slack adapter
decides *how* to render a live card.**

Do not teach `MessagingController` about `task_card` JSON. Extend the semantic
surface just enough for multi-task progress, then specialize in the Slack
adapter.

### 1) Semantic model (shared)

Extend Working Update delivery beyond pure text messages with a **turn-scoped
progress surface** that can be updated:

```ts
// Directional shape — implementer may name/place carefully
type MessagingWorkingCardIntent = {
  kind: "working_card"; // new intent kind OR specialized progress payload
  key: string;          // bindingId + turnId (stable stream key)
  sequence: number;     // monotonic; drop stale
  phase: "queued" | "working" | "waiting" | "completed" | "failed";
  headline: string;     // plain fallback, e.g. "Working: 3 tools…"
  tasks: Array<{
    id: string;         // tool activity id or synthetic batch id
    title: string;      // already redacted/safe
    status: "pending" | "in_progress" | "complete" | "error" | "cancelled";
    detail?: string;    // ≤256 chars after clamp
  }>;
  displayHint?: "timeline" | "plan" | "dense";
  isFinal: boolean;
};
```

**Minimal alternative (preferred if intent surface bloat is a concern):**

Keep delivering tool activities through the existing policy, but add an
optional `deliveryPresentation: "live_card" | "message"` + `cardKey` on the
message/progress path, and let Slack coalesce those deliveries into one stream
surface in-adapter. Controller still emits discrete activities; Slack owns the
live-card fold.

**Recommendation:** use a first-class `working_card` intent. It makes sequence,
phase, and multi-task updates explicit and prevents other adapters from
mis-rendering Slack-shaped blocks. Non-Slack adapters map `working_card` →
existing text batch (`Tool updates: …`) so behavior stays parity.

### 2) Event lifecycle

```
turn/start
  → activity typing active (setStatus)
  → optional working_card phase=queued (if dial ≠ None)

item starts (optional v1.1) / item/completed
  → MessagingToolActivity (extend status to include in_progress later)
  → MessagingToolUpdatePolicy (unchanged thresholds)
  → if delivery admitted:
       emit working_card upsert (sequence++)
     else:
       buffer / drop per dial

approval / questionnaire / waiting_input
  → flush policy
  → working_card phase=waiting (isFinal=false)
  → deliver interactive surface separately (existing)

turn complete / fail / cancel
  → flush policy
  → working_card phase=completed|failed, isFinal=true
  → activity typing idle (clear setStatus)
  → final assistant message (authoritative)
```

### 3) Dial → Slack presentation

| Mode | Task stream behavior | setStatus | Fallback text posts |
| --- | --- | --- | --- |
| None | No working_card | Optional brief shimmer only if already used for typing | None |
| Few (`show_less`) | One stream; `dense`; batches only | Yes while working | Suppress individual tool messages |
| Some | One stream; `plan` or `dense`; first 3 individual tasks then batch | Yes | Suppress tool messages when card open |
| More | One stream; `timeline`/`plan`; more tasks before dense collapse | Yes | Suppress tool messages when card open |
| All | One stream; `timeline`; every admitted activity as its own task update | Yes | Suppress tool messages when card open |

**Critical anti-noise rule:** when a live card is open for a turn, **do not also
post classic "Tool update:" messages** for the same activities. The card
replaces them on Slack. Other providers keep text messages.

### 4) Slack adapter delivery

For each `working_card` key:

1. Ensure target has `channel` + `thread_ts` (post a lightweight root or use
   binding root). If no thread context, fall back to text Working Updates.
2. If stream not open: `chat.startStream` with `task_display_mode` from dial
   and initial `task_update` / markdown headline.
3. On sequence advances: `chat.appendStream` with `task_update` chunks
   (upsert by `task_id`). Clamp titles/details to 256.
4. Cap tasks (e.g. last N=12 visible; older collapse into one "Earlier: N tools"
   synthetic complete task) to stay under 50-block and UX limits.
5. On `isFinal`: `chat.stopStream` with optional terminal markdown
   ("Ready for review" / "Failed"). Attach actions (Open thread / Open PR)
   via stop-stream blocks if available; else follow-up message.
6. Track stream state only in memory (`streamSurfaces`-like map keyed by
   `working_card.key`). Restart-safe: if memory lost, either open a new stream
   or fall back to a single final text summary — never duplicate by guessing.

**Fallback ladder** when stream APIs fail (`missing_scope`, method unavailable,
no thread_ts, channel without recipient identity):

1. Single editable message with `plan`/`task_card` blocks via
   `chat.postMessage` + `chat.update` (≤1 update / 3s, coalesce)
2. Existing text Working Update messages
3. setStatus-only + final answer

### 5) Rate-limit strategy

- Prefer appendStream (Tier 4) over chat.update for in-flight ticks
- Coalesce controller-side first (existing windows); then adapter min-interval
  (~500–1000ms) for appends
- Respect existing delivery budget + Slow Mode: working_card is low priority vs
  final answer / approvals
- On 429: Cool Off; drop intermediate card ticks; keep final stopStream attempt
  once
- Do not count setStatus against the same message budget as posts if Slack
  treats it separately; still throttle status text churn (update status string
  only on phase change)

### 6) Ordering / staleness / duplicates

- Monotonic `sequence` per card key; ignore older sequences
- `seenActivityIds` remains in policy (already)
- Cancel in-flight card deliveries on turn cancel (mirror workingUpdate
  cancellation maps)
- Terminal phase always wins even if intermediate appends fail
- Never re-open a completed card for a new turn; new turn → new key

### 7) UX state mapping

| PwrAgent state | Card phase | Task statuses | Status shimmer |
| --- | --- | --- | --- |
| Bound turn admitted, not started work | `queued` | pending | "is starting…" / working |
| Tools/prose running | `working` | in_progress → complete/error | "is working on your request…" |
| Approval / questionnaire / elicitation | `waiting` | last task complete; headline waiting | clear or "is waiting for input…" |
| Turn success | `completed` | all terminal | clear |
| Turn failure / cancel | `failed` | error/cancelled | clear |

### 8) Security / privacy

- Titles only from existing redactors (`redactCommandText`, safe path basenames)
- Never stream private-reply / sensitive commentary (existing controller bans)
- Public channel: Working Updates are shared; None default for `agent_thread`
  bindings remains correct
- Do not put full PR diffs into the card; link out
- Log stream open/fail without logging task titles that might include paths
  operators consider sensitive in audit logs if policy requires

### 9) Data model / persistence

| Item | Persist? |
| --- | --- |
| Dial preference (`toolUpdateMode`) | Yes (existing) |
| Live stream ts / open stream id | **No** (memory only) |
| Working card sequence | Memory only |
| Delivery audit for final messages | Existing delivery records |

No schema migration required for v1 if preferences stay the same.

## Concrete implementation plan

### PR slice A — Contract + controller

1. Add `working_card` to `MESSAGING_SURFACE_INTENT_KINDS` and types in
   `packages/messaging/interface`.
2. Map dial deliveries in `MessagingController.deliverToolUpdateDelivery` for
   Slack-capable path:
   - Prefer `working_card` when binding channel is Slack **or** when a
     capability flag says live cards supported.
   - Keep text message path for other providers.
3. Emit phase transitions from existing turn lifecycle hooks (start, waiting,
   complete, fail, cancel).
4. Tests:
   - dial None → no working_card
   - Some → batched card updates, no duplicate text on Slack path
   - sequence monotonic / stale drop
   - cancel drops pending card updates
   - non-Slack still gets text batches

### PR slice B — Slack adapter Thinking Steps

1. Wrap `chat.startStream` / `appendStream` / `stopStream` on `SlackApi`.
2. Implement `deliverWorkingCard` with stream state map + fallback ladder.
3. Clamp task fields; choose `task_display_mode` from dial/mode hint.
4. Capture `recipient_user_id` / `recipient_team_id` from inbound actor when
   posting in channels.
5. Tests (adapter unit):
   - start → append task complete → stop
   - no thread_ts → text fallback
   - rate limit error → cool-off fields
   - final phase after missing intermediate still stops stream
   - duplicate task_id updates in place (same id, new status)

### PR slice C — Polish + docs

1. Optional actions on completed card: Open in PwrAgent / PR link (reuse
   existing surfaces).
2. Operator docs note: Working Updates on Slack use live cards when the bot can
   stream in-thread.
3. Changelog entry.

### Suggested file touch list

- `packages/messaging/interface/src/index.ts`
- `apps/desktop/src/main/messaging/core/messaging-controller.ts`
- `apps/desktop/src/main/messaging/core/messaging-renderer.ts`
- `apps/desktop/src/main/messaging/core/messaging-tool-activity.ts` (optional
  in_progress later)
- `packages/messaging/providers/slack/src/slack-adapter.ts`
- `packages/messaging/providers/slack/src/slack-formatting.ts`
- adapter + controller tests
- `docs/messaging-adapter-contract.md` (working_card section)
- `CHANGELOG.md`

## Acceptance criteria

1. With Working Updates = Some on a Slack thread binding, a multi-tool turn
   shows **one** live updating card (not N "Tool update:" messages).
2. Working Updates = None posts **no** live card and no tool text updates;
   final answer still arrives.
3. Working Updates = All surfaces each completed tool as a task on the card
   without violating rate budget / Slow Mode.
4. Waiting for approval updates the card phase to waiting and does not leave a
   permanent "is working" shimmer.
5. Completed turn finalizes the stream; failed turn marks error; cancel stops
   shimmer and does not leave dangling in_progress tasks.
6. If stream APIs are unavailable, adapter falls back to text Working Updates
   without failing the turn.
7. Non-Slack providers unchanged in behavior.
8. Unit tests cover policy mapping + Slack stream lifecycle + fallback.
9. No secrets/raw command output in task titles.
10. Draft PR only when tests pass and behavior is reviewable.

## Risks

| Risk | Mitigation |
| --- | --- |
| Stream APIs behave differently in channel vs DM | Require recipient ids for channels; test both; fallback |
| Card noise in public channels | Keep dial; agent_thread default None; dense mode |
| SDK method typing gaps | Local typed wrappers like existing setStatus cast |
| Double delivery (card + text) | Explicit suppress of text tool messages when card open |
| Stuck shimmer | Always clear status on terminal + lease idle activity |

## Decision

**Implement Slack Thinking Steps live cards as the Slack rendering of Working
Updates**, driven by a channel-agnostic `working_card` (or equivalent) intent,
preserving the existing dial, budgets, redaction, and final-answer authority.

Do **not** rename product settings to "Live Cards"; keep **Working Updates**.
Internally document Slack's name as Thinking Steps / task cards.

## Out of scope follow-ups

- Native assistant answer streaming via `chat.*Stream` (separate feature;
  Working Updates card should not be the final answer surface)
- In-progress tool start events (v1 can stay completion-driven; optional v1.1
  sets `in_progress` on start)
- Linear-style "Open diff" deep link package until PR attachment APIs already
  used by status cards are wired into card actions
