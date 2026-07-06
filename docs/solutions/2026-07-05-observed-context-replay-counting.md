---
title: Observed context-replay counting — the requirements that kept getting lost
type: solution
status: shipped
date: 2026-07-05
tags: [desktop, pricing, token-usage, context-replay, codex, app-server, sqlite]
related_prs: [#856, #871, #933, #945, #948, #950]
related_issues: [#947]
related_plans:
  - docs/plans/2026-07-04-001-feat-observed-context-replay-counting-plan.md
  - docs/plans/2026-06-16-001-feat-thread-pricing-usage-ledger-plan.md
---

# Observed context-replay counting — the requirements that kept getting lost

> **TL;DR.** The Pricing panel shows how many times a turn "replayed" its
> context to the model, split into **hot** (cache hit) and **cold** (cache
> miss) replays with attributed cost. The feature is small in code but its
> *requirements* are subtle, and they were rediscovered the hard way at least
> five times — twice before implementation (a prior agent shipped the opposite
> of the intent) and three times during live testing after the "done" build.
> The recurring failure mode: **treating a request's whole input as the
> replayed context**, when a request is really `replayed context + fresh
> content` and only the replayed part is a replay. If you touch the replay
> accumulator, read the "Invariants" section before changing a formula — every
> one of them is load-bearing and every one was paid for with a wrong number on
> a real screenshot.

## Why this doc exists

This is the artifact the product owner explicitly asked for after the numbers
drifted wrong three separate times post-merge: *"we don't want to lose track of
these detailed requirements again."* The stated intent (below, verbatim) is
short and reasonable; the trouble is that a plausible-looking implementation can
satisfy the *counting* while getting the *attribution* and *classification*
wrong in ways that only show up on a heavy, cache-primed, tool-loop turn — the
kind you don't get in a unit test unless you know to write it.

## The stated intent (verbatim — do not lose this)

From the product owner, before any code:

1. Track the approximate context-window size while usage data arrives for items
   within a turn.
2. If cached-token usage rises by ~90%+ of the context-window size, count a
   **cached (hot)** context-window replay.
3. If uncached-token usage rises by ~90%+ of the context-window size, count an
   **uncached (cold)** context-window replay.
4. The amount attributed to a replay is the **context-window size at that
   time**, *not* merely the cached/uncached delta of that item — each turn also
   submits unrelated new tokens that are not part of the replay. For cached, use
   `min(cached, contextWindowSizeAtThatTime)` because caching sometimes lags for
   the most-recently-completed item.
5. As soon as the turn ends, wipe the per-turn observation state. Do **not**
   fabricate replay counts for turns we did not observe.

Point 4 is the one that got lost repeatedly. "The context-window size at that
time" — not the whole request, not the raw uncached total — is the whole ball
game.

## The protocol reality (what data we actually have)

Every `thread/tokenUsage/updated` notification carries (`codex-app-server/client.ts`
`normalizeTokenUsagePayload`; main-process reader `readTaskMonitorTokenUsageRecords`):

- `total` — the session's **cumulative** token usage. This is a monotonic
  billing counter. It does **not** decrease on context compaction (verified live
  at ~19M input against a 258k window). Every replay-counting invariant leans on
  this monotonicity.
- `last` — the breakdown of the **single most recent model request**
  (`input`, `cachedInput`, `output`, `reasoning`).
- `modelContextWindow` — the model's max window (a ceiling, not the per-request
  size — we do not use it for counting).

Key derivation: `total.input` is the running sum of `last.input`. So **each
`last` snapshot is exactly one context replay** (one model request that
resubmitted the working context), and `total` growing by `last.input` is the
signal that a new request happened. This is strictly better than the intent's
"watch the cumulative rise past 90%" inference — we can see each request
directly.

## Layer 0 — the wrong thing that shipped first

The original feature (#856) computed replays in the **renderer**
(`PricingPanel.tsx` `estimateContextReplayBucket`) by dividing a turn's
cumulative uncached/cached input by a fixed `250_000` bucket — a guess, because
the renderer only ever holds the *latest* snapshot and structurally cannot see
the per-request stream. A follow-up (#871) then gated that estimate to only the
actively-running turn and dropped it the moment the turn completed.

That gating was the opposite of intent point 5. The owner wanted completed turns
to **keep** the counts they observed; #871 read "don't fabricate for unobserved
turns" as "only show the active turn," and hid it everywhere else.

**Lesson.** "Don't invent data for turns we didn't observe" and "drop the
display for finished turns" are different requirements. The fix is to *freeze
the observed result* at turn end, not to *stop showing it*. When feedback says
"that's not what I wanted," re-read the original words before coding the
correction — the correction shipped here was itself a misread of the intent.

## Layer 1 — count in the main process, per request, and freeze

Shipped in #933. The accumulator lives in `BackendRegistry`
(`foldObservedContextReplay` + `observeLiveThreadContextReplay`), where the event
stream is seen one update at a time. Two pieces of per-thread/turn state:

- a per-turn tally (`{coldReplayCount, coldReplayUncachedTokens,
  hotReplayCachedTokens, hotReplayCount}`), and
- a per-thread cursor (originally just the cumulative-input high-water mark).

**Dedup is mandatory, not optional.** Live capture confirmed the backend emits
the *same* `last`/`total` snapshot twice within a turn. A replay is counted only
when `total.input` grows past the per-thread cursor; a non-increasing update is a
no-op. Miss this and every duplicated-emission turn double-counts.

Per intent point 5, the per-turn tally is wiped at `turn/completed` /
`turn/failed` (`forgetCompletedTurnReplayObservations`) — but the final counts
were already frozen onto the persisted line by the last update before completion,
so "wipe the observation state" and "keep the result" coexist. The per-thread
cursor is deliberately **not** wiped, so a late duplicate re-emission after turn
end still dedups instead of re-counting from scratch.

**Lesson.** "Wipe per-turn state at turn end" (point 5) is about the *working
accumulator*, not the *result*. Freeze the result onto durable storage first,
then wipe the scratch state.

## Layer 2 — persistence has to survive transcript hydration

Also #933, then re-architected in #945. This one is a PwrAgent-specific trap.

The observed tally is **derived data** — it exists only because we watched the
live stream; it is nowhere in the Codex transcript. But `readThread` (every
thread open/refresh) re-persists transcript-**hydration** usage lines, and those
*supersede* the `source: "live"` line that held the tally. So the first version
(#933) kept the tally on `thread_usage_lines` and added a guard to stop hydration
from superseding an observed line — a special case bolted onto the generic
supersede path.

#945 moved the tally to the per-turn record `thread_usage_turns` (keyed by a
`usage_turn_id` derived identically for live and hydration lines), COALESCE-
preserved on write, and re-joined onto the displayed line at read time in
`readThreadPricing`. Hydration now supersedes normally *and* the tally survives —
the guard is gone. (SQLite migration `user_version` 24 added the line columns;
25 moved them to the turn record. A deprecated dual-write to
`thread_usage_lines` remains for older local builds, tracked in #947.)

**Lesson.** Derived state that the source-of-truth (here, the transcript) can't
reproduce must not live on a row whose lifecycle is "gets replaced by the source
of truth." Put it on a record the reconciliation *updates in place*, not one it
*supersedes*. If you find yourself writing a guard to stop the generic
reconciliation from clobbering your special row, that's the smell — relocate the
data instead.

## Layer 3 — attribution: a cold request is not all replay

First live-testing surprise (thread `019f2d68…`). A single cold request submitted
73,766 input tokens after a turn whose context was ~54k. The naive attribution
counted all 71,334 uncached as "cold replay overhead." But only ~54k of that was
the *resubmitted prior context*; the remaining ~17k was **fresh** prompt/tool
content sent with the request — content that would be billed regardless of any
replay.

Fix (`d325ef8a`): the per-thread cursor gained `lastContextTokens` = the previous
request's `input + output`, surviving across turns. Cold attribution is capped at
`min(uncached, priorContextTokens)`. This is intent point 4 — "the
context-window size at that time" — finally implemented literally.

**Lesson.** `last.input = replayed context + fresh content`. The fresh content is
derivable (`last.input − priorContext`) even though the protocol has no explicit
field for it. Any per-request replay math that uses `last.input` whole is wrong;
it must use the replayed portion.

## Layer 4 — classification: fresh payload must not flip hot to cold

Second live surprise, same day (thread `019f2d68…`, turn `…a740b1ae`, a 16-request
review tool-loop). Two requests that read large files (`sed` dumps) were counted
**cold** — even though their replayed context was fully cache-served. Why: the
classifier compared `cached` against the request's **whole input**, and the big
fresh file payload diluted the cached fraction below the 90% line.

Fix (`789d5312`): everything measures against `replayed = min(last.input,
priorContext)` — the size floor (`replayed >= 32k`, so a mostly-fresh request over
a tiny prior context is not a replay at all), the hot/cold threshold
(`cached >= 0.9 × replayed`), and attribution. Fresh tokens are excluded from
replay logic entirely.

**Lesson.** Layer 3 fixed *how much* a cold replay is worth; Layer 4 fixed
*whether* a request is cold at all. They are the same root cause (whole-input vs
replayed-portion) showing up in two different places. When you fix a "use the
replayed portion" bug in one spot, grep for every other place the whole input is
used and fix them together.

## Layer 5 — one-or-the-other, and the cache-served slice

The product owner then asked the sharpest question of the series: could a single
item be counted as *both* a cold and a hot replay ("60k uncached ≥ context size,
so cold; 50k cached = context size, so also hot")? Two findings:

1. **A single request is exactly one replay.** The classifier is a strict
   `if/else`, so structurally it can only be hot *or* cold, never both. Cached
   takes precedence: `cached >= 0.9 × replayed` → hot, full stop; the uncached
   remainder is fresh input, attributed nowhere.
2. **But cold attribution was still over-counting** on a *partial* cache hit
   below the threshold. `min(uncached, replayed)` counted the cache-served slice
   of the replayed context as uncached overhead. Corrected (in the delta review,
   `bf0ad859`) to `min(uncached, replayed − cached)` — equal when there's no
   fresh content, strictly more accurate otherwise, and always positive in the
   cold branch (`cached < 0.9 × replayed`).

That same review also fixed a cadence bug: a duplicate re-emission with an
exactly-equal cumulative total now refreshes the context snapshot with any
late-booked output (some cadences emit at input-time with `output: 0`, then
re-emit at completion), so the next request's replayed portion isn't
underestimated near the floor.

**Lesson.** "It's one or the other, not both" was correct about the *item*, but
the real bug was inside the one branch it did take. When someone reports a
double-count, check both "did we double-count across buckets" (no) and "is the
single bucket's amount right" (it wasn't). And: cached tokens are
previously-seen content by definition — they belong *inside* the replayed
window, never in the uncached overhead.

## Layer 6 — a genuine cold replay is not always a bug

A later report (thread `019f1a0e…`, turn `…97059b28`) showed the cold count rising
mid-turn on a cache-primed thread — suspicious. The DB exonerated the counter: of
369,260 turn uncached, only 286,877 was attributed to cold replays (82,383
correctly left as fresh/lag tails), and one cold was a **genuine** cache-TTL
expiry — the review orchestrator sat idle ~5.5 minutes waiting for six sub-agents
to finish, past OpenAI's prompt-cache window, so the resume was truthfully billed
uncached.

**Lesson.** Once the caps are right, a cold replay on a "warm" thread is often
real (best-effort caching misses under parallel load; TTL expiry during long
waits). Don't reflexively treat a surprising cold as a counting bug — check the
DB attribution first. The counter labels where billed tokens went; it does not
invent them.

## Invariants (change these only with a failing test and a good reason)

The accumulator (`backend-registry.ts` `foldObservedContextReplay`) holds these.
Every one traces to a wrong number on a real screenshot.

- **`replayed = min(last.input, priorContext)`**, where
  `priorContext = previous request's (input + output)`, per thread, surviving
  turn boundaries. No prior snapshot (first observed request after app start) →
  fall back to the whole `last.input`.
- **Count only when `total.input` grows** past the per-thread cursor. Duplicates
  (non-increasing total) are no-ops; an exactly-equal duplicate refreshes the
  context snapshot but does not count.
- **Floor on `replayed`, not `last.input`**: `replayed >= 32_000`
  (`MIN_OBSERVED_CONTEXT_REPLAY_INPUT_TOKENS`).
- **Classify on `replayed`**: hot when `cached >= 0.9 × replayed`
  (`OBSERVED_HOT_CACHE_FRACTION`), else cold. Strict `if/else` — exactly one
  bucket per request.
- **Cold attribution = `min(uncached, replayed − cached)`.** Hot attribution =
  `cached` (already `min(cached, last.input)`).
- **`total` is cumulative and monotonic.** Do not add "reset on compaction"
  logic — compaction shrinks future `last`, not the cumulative counter.
- **Absent observed fields mean "not observed," never "zero."** No backfill:
  historical turns we never watched live get no counts.

## Where the code lives

| Concern | Location |
|---|---|
| Pure accumulator + per-request classification | `apps/desktop/src/main/app-server/backend-registry.ts` — `foldObservedContextReplay`, `ObservedContextReplayCursor` |
| Wiring / per-thread+turn state / turn-end wipe | same file — `observeLiveThreadContextReplay`, `forgetCompletedTurnReplayObservations` |
| Dev diagnostic (per-request classification log) | same file — `logObservedContextReplayDecision` → `logDebug("contextReplay:classify", …)` (#950) |
| Transport type (observed fields on the usage line) | `packages/shared/src/token-usage-pricing.ts` — `ThreadUsageLineRecord.observed*` |
| Persistence (turn record + COALESCE + read-join) | `apps/desktop/src/main/state/overlay-store-sqlite.ts`; migrations in `state-db.ts` (`user_version` 24→25) |
| Display | `apps/desktop/src/renderer/src/features/thread-detail/context-panels/PricingPanel.tsx` — `formatContextReplayEstimate`, `readObservedReplaySummary` |
| Synthetic capture fixture + generator | `apps/desktop/src/main/__tests__/fixtures/context-replay/` |

## Diagnosing "why was this request cold?"

`logDebug("contextReplay:classify", …)` (#950) emits one line per genuinely new
request with `classification`, `lastInput`, `cached`, `priorContext`, `replayed`,
and `attributed`. It streams to the `pnpm dev` console unfiltered (electron-log
routes debug there with no toggle); the log file / in-app Logs window only capture
it when "collect debug logs" is on. It is `isDevelopment`-gated — a no-op in
packaged builds. For byte-level protocol forensics, `PWRAGENT_PROTOCOL_CAPTURE=1`
writes the raw stream to `<profile>/state/protocol-captures/`, replayable through
the fold.

## Open follow-ups

- **#948** — extend counting to sub-agent threads (review fan-outs, task
  monitors, codex native sub-agents), which currently show cost but no replay
  counts because their usage bypasses the observe path. Resolves plan open
  question O3.
- **#947** — drop the deprecated `thread_usage_lines` dual-write once no
  locally-run build depends on it.
- **First-request-after-restart / mid-turn restart** — with no in-memory prior
  snapshot, the first observed request classifies/attributes against its full
  input. Documented, not fixed: seeding the prior-context from the thread's last
  persisted line would close it.
