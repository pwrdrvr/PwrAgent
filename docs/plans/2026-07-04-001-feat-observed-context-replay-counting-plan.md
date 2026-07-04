# Observed Context-Replay Counting — Implementation Plan

- **Date:** 2026-07-04
- **Status:** Draft (decision artifact — not yet executed)
- **Area:** `apps/desktop` (main-process token-usage observation + renderer pricing display)
- **Related prior work:**
  - #856 `feat(desktop): estimate context replay pricing` (introduced the current bucket heuristic)
  - #871 `fix(desktop): limit context replay estimates to live turns` (gated it to the active turn — this is the behavior the product owner flagged as *not* what was wanted)
  - #— `feat(desktop): thread pricing usage ledger` (`docs/plans/2026-06-16-001-feat-thread-pricing-usage-ledger-plan.md`)

---

## 1. Problem

The Pricing panel shows, for the active live turn:

```
Estimated cold context replays: 1 (41,344 uncached · $0.21)
Estimated hot context replays: 6 (~41,344 cached avg; 248,064 cached bucket · $0.13)
```

These numbers are produced by a **turn-final bucket heuristic** in the renderer
(`PricingPanel.tsx` → `estimateContextReplayBucket`): it takes the turn's
cumulative uncached / cached input totals and divides by a fixed
`MAX_ESTIMATED_CONTEXT_REPLAY_TOKENS = 250_000` bucket. This is a guess, not a
measurement. It:

- Cannot see the per-request structure of the turn.
- Mis-estimates whenever the context window is not ~250k.
- Was subsequently gated to only the actively-running turn (#871). The product
  owner's actual intent: **observe replays as usage data arrives during a turn,
  count them, and wipe the observation state when the turn ends** — *not* invent
  counts for turns we never observed, and *not* silently drop the feature for
  the active turn too.

### Product owner's stated algorithm (verbatim intent)

1. Track the approximate context-window size while usage data arrives for items
   within a turn.
2. If cached-token usage rises by ~90%+ of the context-window size, count a
   **cached (hot)** context-window replay.
3. If uncached-token usage rises by ~90%+ of the context-window size, count an
   **uncached (cold)** context-window replay.
4. The amount attributed to a replay is the **context-window size at that time**,
   not merely the cached/uncached delta of that item (each turn also submits
   unrelated new uncached tokens that are not part of the replay). For cached,
   use `min(cached, contextWindowSizeAtThatTime)` because caching sometimes lags
   for the most-recently-completed item (a partial cache miss on recent items).
5. As soon as the turn ends, wipe the per-turn observation state. Do **not**
   fabricate replay counts for turns we did not observe.

---

## 2. Key finding: the protocol already segments usage per model request

Investigation of the token-usage protocol and a real captured transcript shows
we have **more** signal than the inference algorithm above assumes.

Every `thread/tokenUsage/updated` notification carries
(`apps/desktop/src/main/codex-app-server/client.ts` `normalizeTokenUsagePayload`,
mirrored in `apps/desktop/src/renderer/src/lib/useThreadSessionState.ts`
`readTokenUsageRecords` / `normalizeThreadContextWindowState`):

- `total` / `total_token_usage` — cumulative usage for the session.
- `last` / `last_token_usage` — the breakdown of the **single most recent model
  request** (input, cached input, output, reasoning).
- `modelContextWindow` — the model's max window (e.g. `258400`).

Confirmed against `apps/desktop/src/main/__tests__/fixtures/codex-transcripts/codex-thread-1.json`:

| request | `last.input` | `last.cached` | uncached (cold) | `total.input` (cumulative) |
|--------|-------------|--------------|-----------------|----------------------------|
| 1      | 21,695      | 3,456        | 18,239          | 21,695                     |
| 2      | 25,930      | 21,376       | 4,554           | 47,625                     |
| 3      | 28,530      | 3,456        | 25,074          | 76,155                     |

`total.input` is the running sum of `last.input`. Therefore:

- **Each `last` snapshot *is* one context replay** (one model request that
  resubmitted the working context).
- Its cached vs uncached split tells us directly whether that replay was **hot**
  (request 2: 82% cached) or **cold** (request 3: cache miss, 12% cached).
- Request 3 is exactly the "cache miss on recent items" case from intent step 5 —
  it emerges from the data without inference.

**Implication:** we can *count replays directly* by observing the sequence of
`last` snapshots during a turn, rather than inferring them by dividing a
cumulative total by a bucket size. This is strictly more accurate than the
stated inference algorithm, and the inference algorithm becomes the documented
fallback (see §6).

---

## 3. Why the current code cannot do this (architecture)

`estimateContextReplayBucket` lives in the **renderer**
(`PricingPanel.tsx`). The renderer only ever holds the *latest* snapshot —
`normalizeThreadContextWindowState` overwrites `contextWindow` on every
`thread/tokenUsage/updated` event, and `buildPendingTurnUsage` keeps only a
per-turn baseline, not the per-request series. So the renderer structurally
cannot count replays; dividing a total by a bucket is the best it can do there.

The event stream is observed one-by-one in the **main process**:

- `BackendRegistry.recordLiveThreadUsage` (`backend-registry.ts`) handles each
  `thread/tokenUsage/updated`.
- `deriveLiveThreadTokenUsage` (`backend-registry.ts`) already maintains a
  **per-turn baseline** keyed by `backend:threadId:turnId:live-token-usage` in
  `this.liveThreadUsageBaselines`, and computes turn usage as
  `total − baseline`.

This is the correct home for a per-turn **replay accumulator**: it sees every
update, it already scopes state per active turn, and it can wipe on turn end.

---

## 4. Definitions to lock down

- **Context replay** — a single model request within a turn that resubmits the
  working context. Observed as one `last` snapshot / one increment of
  `total.input`.
- **Cold replay** — a replay whose input was predominantly *uncached* (cache
  miss on the context). Billed at the uncached input rate.
- **Hot replay** — a replay whose input was predominantly *cached* (cache hit).
  Billed at the cheaper cached input rate.
- **Classification threshold** — a replay is "hot" when
  `cached >= HOT_CACHE_FRACTION * last.input` (start at `HOT_CACHE_FRACTION =
  0.9`, matching the intent's "~90%"), otherwise "cold". Small non-context
  requests (below `MIN_CONTEXT_REPLAY_INPUT_TOKENS`) are not counted as replays
  at all — carried over from the existing `32_000` floor.
- **Context-window size at that time** — prefer `last.input` (the actual context
  submitted for that request); `modelContextWindow` is the ceiling, not the
  per-request size. Attribute `min(cached, last.input)` to the hot bucket per
  intent step 4/5.

> Open question O1 (resolve during implementation): do we report cold/hot as a
> **count of requests** in each class (recommended — it is what "replays" means),
> or as a **token/cost split** where every replay contributes its uncached
> portion to cold cost and cached portion to hot cost? The current UI conflates
> the two. Recommendation: report **count of replays per class** plus the summed
> cost attributed to that class, computed from the observed per-request splits.

---

## 5. Proposed design (observed counting)

### 5.1 Data captured per active turn (main process)

Add a per-turn accumulator alongside `liveThreadUsageBaselines`, keyed the same
way (`backend:threadId:turnId`). It records, as updates arrive:

- `lastCumulativeInput` — the previous `total.input` we saw, to detect a new
  request (a genuine increase).
- `replays: Array<{ input; cached; uncached; hot: boolean; modelContextWindow }>`
  — one entry per observed request, or a compacted counter form:
  `{ hotCount, coldCount, hotCachedTokens, coldUncachedTokens }`.

On each `thread/tokenUsage/updated`:

1. Read `total`, `last`, `modelContextWindow` (reuse existing readers).
2. If `total.input` did **not** increase since `lastCumulativeInput`, ignore
   (duplicate / no new request). Update nothing.
3. Otherwise a new request happened. Prefer `last` for its split. Sanity-check:
   the increment `total.input − lastCumulativeInput` should ≈ `last.input`; if
   they diverge (missed intermediate notification), fall back to attributing the
   increment via the delta-inference rule (§6) so counts stay correct even when
   individual splits are lost.
4. Classify hot/cold via `HOT_CACHE_FRACTION`. Skip requests below
   `MIN_CONTEXT_REPLAY_INPUT_TOKENS`.
5. Accumulate into `replays` and set `lastCumulativeInput = total.input`.

### 5.2 Surfacing the result

- Attach the accumulated replay summary to the live turn usage line built in
  `buildLiveThreadUsageLine` (`backend-registry.ts`) — new optional fields on
  `ThreadUsageLineRecord` (`packages/shared/src/token-usage-pricing.ts`), e.g.
  `observedColdReplays`, `observedHotReplays`, and their attributed token/cost
  fields. These are **observation-derived**, distinct from the existing
  cumulative fields.
- The renderer (`PricingPanel.tsx`) **stops computing** replay counts. It renders
  the observed fields when present, and renders nothing when absent (no more
  bucket division). `estimateContextReplayBucket` /
  `refineColdContextReplayBucket` are deleted.

### 5.3 Lifecycle / wipe (intent step 5)

- On `turn/completed` / `turn/failed` (and `thread/compacted`), delete the
  turn's accumulator entry, exactly as the baseline map is scoped today.
- The **final** observed counts are frozen onto the persisted usage line for
  that turn at completion, so a finished turn keeps showing what was actually
  observed — but we never *recompute* or *fabricate* counts for turns whose
  stream we did not observe (e.g. rehydrated history). If a persisted line has
  no observed-replay fields, the panel shows nothing for it. This directly fixes
  the #871 complaint: active turns show live observed counts, completed observed
  turns keep their real counts, unobserved history shows nothing.

---

## 6. Fallback: delta inference (the product owner's original algorithm)

If step 1 verification (§7) shows the desktop does **not** reliably receive a
per-request update stream (e.g. only a single cumulative update at turn end),
per-request `last` splits are unavailable and we implement the stated inference
instead, still in the main-process accumulator:

- Track `cachedRun` and `uncachedRun` deltas of `total` between observed updates.
- Each time `uncachedRun` crosses `~0.9 * contextWindowSizeAtThatTime`, count a
  cold replay and subtract a window's worth.
- Each time `cachedRun` crosses `~0.9 * contextWindowSizeAtThatTime`, count a
  hot replay using `min(cached, contextWindowSize)` and subtract.
- `contextWindowSizeAtThatTime` = most recent `last.input` if present, else the
  running per-turn max of observed `total.input` increments, else
  `modelContextWindow`.

This is strictly less accurate but honors the same intent and shares the same
lifecycle/wipe machinery, so the two modes differ only in the classification
step.

---

## 7. Work plan

- [x] **Step 1 — Verify live cadence (partially confirmed).** Enable capture
      with `PWRAGENT_PROTOCOL_CAPTURE=1` (alias `PWRAGENT_APP_SERVER_PROTOCOL_LOG=1`);
      captures default to `<profile>/state/protocol-captures/`, overridable with
      `PWRAGENT_PROTOCOL_CAPTURE_ROOT` (a dev run redirected them to
      `apps/desktop/.local/protocol-captures/`). Findings from a real capture of
      a forked thread (`019f2d5a-c460-…`, two turns):
    - **Confirmed** we receive `thread/tokenUsage/updated` **live**, each carrying
      `total`, `last`, and `modelContextWindow` (`258400`). `last` is the
      per-request breakdown; `total` is cumulative and monotonic across the whole
      forked session lineage.
    - **Confirmed cold→hot across turns:** after the fork, turn 1 was cold
      (`last`: 159,802 in / 4,992 cached → 154,810 uncached) and turn 2 was hot
      (159,821 in / 159,104 cached → 717 uncached) once the context warmed.
    - **Duplicate emissions happen.** Turn 1 emitted the *identical* `last`/`total`
      snapshot twice (seq 112 & 144). **Dedup on a non-increasing
      `total.inputTokens` is mandatory** or every such turn double-counts.
    - **Gap:** both captured turns were trivial *single-request* turns, so the
      real capture does **not** exercise the within-turn multi-request replay
      case. The multi-request shape is still evidenced by the persisted
      `codex-thread-1.json` transcript (§2). To fully validate live, capture a
      heavy turn (many tool round-trips). A **synthetic** capture-shaped fixture
      covering a 6-request turn (2 cold + 4 hot) plus a duplicate-emission dedup
      case was built (scratchpad `synthetic-codex-replay-capture.jsonl` +
      `gen_replay_fixture.py`, fully fabricated / no PII) — promote it into the
      repo test fixtures in Step 6. Verdict: proceed with §5 (observed counting);
      §6 inference remains the documented fallback for coarse/missed streams.
- [ ] **Step 2 — Shared types.** Add observed-replay fields to
      `ThreadUsageLineRecord` in `packages/shared/src/token-usage-pricing.ts`
      (and any pricing-summary aggregation that must carry them).
- [ ] **Step 3 — Main-process accumulator.** Implement the per-turn replay
      accumulator in `BackendRegistry`, populated from `recordLiveThreadUsage` /
      `deriveLiveThreadTokenUsage`, wiped on turn end. Constants:
      `HOT_CACHE_FRACTION`, reuse `MIN_CONTEXT_REPLAY_INPUT_TOKENS`.
- [ ] **Step 4 — Emit on the usage line.** Populate the new fields in
      `buildLiveThreadUsageLine`; freeze final counts at turn completion.
- [ ] **Step 5 — Renderer.** Delete `estimateContextReplayBucket` &
      `refineColdContextReplayBucket`; render observed fields only; keep the
      "hide for unobserved persisted rows" behavior from #871 but now driven by
      presence of observed fields rather than active-turn gating.
- [ ] **Step 6 — Tests.** Unit-test the accumulator against the
      `codex-thread-1.json`-style sequence (expect 2 cold + 1 hot for the table
      in §2 at the chosen threshold). Update `ThreadContextPanel.test.tsx` /
      `thread-pricing-panel` E2E to assert observed counts, replacing the bucket
      assertions in #871's tests.
- [ ] **Step 7 — Solution doc.** On success, write
      `docs/solutions/2026-07-04-observed-context-replay-counting.md` capturing:
      the protocol shape (`total`/`last`/`modelContextWindow`), the "each `last`
      is a replay" insight, why counting must live in the main process, the
      hot/cold threshold, and the lifecycle/wipe rule.

---

## 8. Open questions

- **O1** — Report replays as counts-per-class or as a token/cost split? (§4).
  Recommendation: counts + attributed cost.
- **O2** — `HOT_CACHE_FRACTION` value. Start at `0.9`; revisit after seeing real
  streams (a mid-turn compaction or a fresh cache can produce a genuinely
  ~50/50 request that neither bucket should claim as a "full" replay).
- **O3** — Sub-agents / monitors (`buildTaskMonitorUsageLine`,
  `deriveLiveThreadTokenUsage`'s monitor path) also produce usage lines. Decide
  whether observed replays apply to them or only to primary thread turns.
- **O4** — Persistence: do observed fields round-trip through
  `overlay-store-sqlite` `thread_usage_lines`, or stay transient on the live
  line only? (Ties to whether completed turns should keep counts across app
  restart. Leaning: persist the frozen final counts.)

---

## 9. Non-goals

- Reconstructing replay counts for historical turns we never observed live.
- Changing how base per-turn token totals or list-price cost are computed.
- Touching Codex-owned storage — all signal comes from protocol fields, per the
  Codex data boundary.
