# Fix: forked threads must not re-bill inherited parent history

- **Date:** 2026-07-04
- **Status:** implemented (tests green: typecheck, boundaries, sql/color/codex-storage lints, backend-registry + overlay-store-usage-pricing + ThreadContextPanel suites)
- **Branch:** `claude/pensive-bohr-428965`
- **Area:** `desktop` / `agent-core` pricing (`PricingPanel`, `BackendRegistry` live token usage)

## Problem

A thread forked from another thread shows a fabricated **"Historical usage
estimate"** cost for the context copied in at the fork point. Real screenshot
(codex backend, `gpt-5.5`):

- `Historical usage estimate` — `1,172,721 uncached in · 17,628,672 cached ·
  46,199 out (9,979 reasoning)` — **`$16.37 estimated list price`** — running
  total `$16.37 (includes estimates)`.
- Two genuine live `Turn usage` rows for the two turns actually run in the fork
  (`$0.084` and `$0.78`).

That `$16.37` block is the **parent thread's history copied into the fork at the
fork point**. It was already billed on the original thread. We must not invent a
cost for it on the fork.

Repro thread id: `019f2d5a-c460-73f0-9f50-fba94f37eb1c` (forked, then ran 2
turns). Protocol capture (PII — do **not** commit):
`apps/desktop/.local/protocol-captures/2026-07-04T13-38-46-782Z-codex-default.jsonl`.

Math that confirms it: the fork's first observed cumulative `total.input` ≈
19,121,016, `total.cached` = 17,792,768. The "historical estimate" gap =
cumulative total − the two observed live turns:
`1,328,248 − 717 − 154,810 = 1,172,721` uncached;
`17,792,768 − 159,104 − 4,992 = 17,628,672` cached — exactly the forked-in
parent history.

## Root cause

Two collaborating facts:

1. **Main process** (`apps/desktop/src/main/app-server/backend-registry.ts`,
   `deriveLiveThreadTokenUsage` ~L12570): the per-turn baseline is seeded as
   `total − latest` on the first observed `thread/tokenUsage/updated`. For a
   fork, the very first `total` already contains the whole copied-in parent
   context, so the per-turn split is *correct* but the cumulative `total`
   stamped onto the live usage line (`cumulative*` fields) is inflated by the
   inherited history.
2. **Renderer** (`.../context-panels/PricingPanel.tsx`,
   `buildPricingDisplayLines` ~L204): for the first main-thread line it computes
   `gapTokens = cumulativeTokens − (accountedMainTokens + lineTokens)` and, when
   non-empty, prices it via `buildEstimatedHistoricalGapLine` (~L499) tagged
   `estimatedUsageGap` → "Historical usage estimate". For a fork the gap is the
   entire inherited history, and it gets priced as this thread's cost.

The renderer cannot tell "history this thread paid for but we didn't watch live"
(keep estimating) from "history inherited at a fork point" (do not charge). It
has no fork signal, and `parentThreadId` on the thread is **overloaded**
(fork, `startThread` grouping, manual reparent, sub-agent rollup), so it is not
a reliable fork discriminator on its own.

## Fix strategy — mark the fork baseline as data

Prefer fixing the data over a renderer heuristic. Persist the fork-point
inherited context as a real, **zero-cost** usage line so the renderer both (a)
stops inventing a priced gap and (b) has an explicit thing to render as a "Fork
point" card.

### 1. Persist a fork-origin marker on the forked thread

`ThreadOverlayState` is stored as a JSON `payload` blob (no column migration
needed). Add:

- `forkSourceThreadId?: ThreadIdentifier` — the thread this fork was created
  from. Set **only** by `forkThread` (unambiguous fork signal, distinct from the
  overloaded grouping `parentThreadId`).
- `forkBaselineCaptured?: boolean` — set true once we've persisted the
  fork-baseline line, so we capture it exactly once and it survives restart.

`BackendRegistry.forkThread` (~L7891) already writes several overlay fields
after the Codex `thread/fork` RPC; add one write recording
`forkSourceThreadId = request.sourceThreadId`.

### 2. Capture the inherited baseline from the fork's own first turn

Measuring from the fork's own first `total − latest` is more robust than reading
the parent's cumulative (which may be missing/untracked, and Codex compacts
history on fork with `excludeTurns`/`persistExtendedHistory:false`).

- `deriveLiveThreadTokenUsage` returns the freshly-seeded baseline
  (`total − latest`) when — and only when — it seeds it on this call.
- In `recordLiveThreadUsage`, when the thread overlay has `forkSourceThreadId`
  and **not** `forkBaselineCaptured`, and a baseline was just seeded, build and
  upsert a **fork-baseline usage line** and mark `forkBaselineCaptured`.

Fork-baseline line shape (`buildForkBaselineUsageLine`):
- `scope: "fork-baseline"` (new union value; `scope` is plain `TEXT`, no CHECK —
  round-trips with no migration).
- `source: "backfill"`, `status: "finalized"`, stable
  `usageLineId: "fork-baseline:<threadId>"`.
- token fields = inherited breakdown (`total − latest`), **no `cumulative*`
  fields** (so the renderer computes no gap for it).
- all cost micros `0`, `priceStatus: "priced"` (known cost = $0 to this thread;
  keeps it out of the unpriced warning).
- `parentThreadId` left **unset** so the line rolls up under the fork's own id,
  not into the fork's grouping parent.
- `createdAt` = just before the first turn so it sorts oldest.

### 3. Renderer: render the fork-baseline line, stop inventing the gap

Because the fork-baseline line is a real "main" line whose tokens land in
`accountedMainTokens` before the first live turn, the first turn's
`gapTokens` collapses to 0 → no "Historical usage estimate". Then:

- `formatUsageLineTitle` → `"Fork point"` for `scope === "fork-baseline"`
  (checked before the historical-summary/estimate branches).
- `formatUsageLineEstimates` → attribution copy for fork-baseline lines instead
  of a `$` figure, e.g. *"Inherited from parent thread — billed there, not
  re-charged here."* The token breakdown line already prints the inherited
  `… uncached in · … cached · … out` counts (requirement 3).
- Suppress the running-total row for the fork-baseline line (its incremental
  cost is $0).

### 4. Non-fork threads unaffected

Non-fork threads never get `forkSourceThreadId`, so no fork-baseline line is
persisted, so a genuine cumulative-vs-observed gap still surfaces as today's
"Historical usage estimate". (Requirement 4.)

## Files to touch

- `packages/shared/src/token-usage-pricing.ts` — add `"fork-baseline"` to
  `ThreadUsageLineScope`.
- `packages/shared/src/contracts/navigation.ts` — add `forkSourceThreadId`,
  `forkBaselineCaptured` to `ThreadOverlayState`.
- `apps/desktop/src/main/state/overlay-store-sqlite.ts` +
  `OverlayStoreLike` interface — `recordThreadForkOrigin` /
  `setThreadForkBaselineCaptured` (JSON payload writes; optional methods).
- `apps/desktop/src/main/app-server/backend-registry.ts` — set fork origin in
  `forkThread`; surface seeded baseline from `deriveLiveThreadTokenUsage`; build
  + persist fork-baseline line in `recordLiveThreadUsage`;
  `buildForkBaselineUsageLine` helper.
- `apps/desktop/src/renderer/src/features/thread-detail/context-panels/PricingPanel.tsx`
  — fork-baseline title / estimate / running-total handling.

## Tests (synthetic fixtures only — no PII capture)

- **Renderer** (`ThreadContextPanel.test.tsx` pricing tab): a fork-baseline line
  + two turn lines whose cumulative totals include the inherited block →
  asserts a "Fork point" card, **no** "Historical usage estimate", running total
  excludes the inherited cost, INPUT still reflects inherited tokens.
- **Renderer regression**: a non-fork thread with a real cumulative-vs-observed
  gap still renders "Historical usage estimate" (requirement 4).
- **Main process** (`backend-registry.test.ts`): drive `thread/fork` then a
  synthetic `thread/tokenUsage/updated` carrying `total`/`last` shaped like the
  capture; assert exactly one persisted `scope: "fork-baseline"` line with the
  inherited breakdown, zero cost, and `forkBaselineCaptured` set; a second turn
  does not create a second fork-baseline line.

## Coordination

Sibling branch `plan/observed-context-replay-counting` also edits `PricingPanel`
(cold/hot replay bucket). This fork fix is independent; keep edits localized to
the fork-baseline title/estimate/running-total helpers to minimize conflict.

## Resolved during implementation

`OverlayStoreSqlite.upsertThreadUsageLine` runs every openai line through
`repriceOpenAiUsageLine`, which recomputes cost from token counts — it would
have re-inflated the fork-baseline line's $0 back to ~$16 on persist (and thus
into the persisted summary). Fixed by exempting `scope: "fork-baseline"` lines
from repricing (always $0, priced). Caught by the sqlite round-trip test; the
main-process test uses a non-repricing mock store and did not surface it.

## Review follow-ups (applied)

Multi-agent review of PR #936 surfaced fixes applied in a follow-up commit:

- **First-turn guard.** `captureForkBaselineUsageLine` now skips (and latches)
  when the thread already has an observed turn line for a *different* turn
  (`threadHasObservedTurnBefore`) — the seeded `total − latest` baseline only
  equals the inherited context on the fork's genuine first turn. Covers the
  observed-earlier-turn-but-latch-not-yet-written window; the never-observed
  first turn remains a limitation (below).
- **Capture can't block the emit.** The capture call in `recordLiveThreadUsage`
  is wrapped in try/catch so a fork-line persist failure no longer suppresses
  the load-bearing `thread/pricing/updated` push for the already-persisted turn.
- **Repricing strip parity.** The `scope: "fork-baseline"` exemption in
  `repriceOpenAiUsageLine` now strips `pricingCatalogId`/`pricingRateId`/
  `pricingCatalogVersion`/`priceUnavailableReason` like the normal path, so a
  $0 "priced" line never carries a stale rate id or unavailable-reason.
- **Latch dedupe.** The `forkBaselineCaptured` write is a single
  `latchForkBaselineCaptured` helper instead of a copy-pasted branch.

Deferred (not fragile enough to warrant the churn now): generalizing the
scattered `isForkBaselineLine` renderer dispatch + scope-literal reprice gate
into one `carriesOwnCost`/`noReprice` predicate; the persisted-summary token
inflation (no consumer beyond PricingPanel reads those fields today).

## Known limitation

If the app first observes a fork at turn N>1 (fork's earlier turns never watched
live), the captured baseline folds those earlier own-turns into the inherited
amount (under-billing them). Forks normally run immediately after creation, so
turn 1 is observed; documented, not handled.
