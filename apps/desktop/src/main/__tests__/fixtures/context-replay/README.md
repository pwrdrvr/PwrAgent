# context-replay test fixtures

Synthetic Codex protocol-capture data for the observed context-replay counting
work (plan:
[`docs/plans/2026-07-04-001-feat-observed-context-replay-counting-plan.md`](../../../../../../../docs/plans/2026-07-04-001-feat-observed-context-replay-counting-plan.md)).

## Files

- `generate-replay-capture.py` — zero-dependency stdlib generator. Run
  `python3 generate-replay-capture.py` to (re)write the `.jsonl` next to it.
- `synthetic-codex-replay-capture.jsonl` — the generator's committed output.
  One JSON envelope per line, matching the real protocol-capture shape
  (`{ backend, direction, kind, method, sequence, timestamp, threadIds, raw }`,
  where `raw` is the JSON-RPC notification string).

## Why synthetic

These replace a real live capture that could not be committed because it
contained PII (a user email, another user's home path). The shape — the
`thread/tokenUsage/updated` payload `{ tokenUsage: { total, last,
modelContextWindow } }`, `total` as the running sum of `last`, and duplicate
emissions of an unchanged snapshot — was reproduced faithfully from the real
capture; only the ids and token counts are fabricated. All ids use a
`0000fake-…` prefix. Do not add real capture data here.

## What it exercises

- **Turn A** — a 6-request turn (the true within-turn replay case): 2 cold
  (cache-miss) + 4 hot (cache-hit) replays, including a mid-turn cache miss.
- A **duplicate emission** after request 3 (identical `last`/`total`) so the
  accumulator can be asserted to dedup on a non-increasing `total.inputTokens`.
- **Turn B** — a single-request hot turn, like the real capture's second turn.

Expected classification at `HOT_CACHE_FRACTION = 0.9`: Turn A → 2 cold + 4 hot;
Turn B → 1 hot.
