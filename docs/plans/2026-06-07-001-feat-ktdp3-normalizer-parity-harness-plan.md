---
title: "feat: KTD-P3 lossless-replay normalizer parity harness (Wave 2 Phase B / B1)"
status: in-progress
---

# KTD-P3 normalizer parity harness (Phase B / B1)

This is **B1** from the Wave 2 plan
([2026-06-06-001](2026-06-06-001-feat-acp-agent-kit-adoption-and-settings-redesign-plan.md)
§"Phase B"): the lossless-replay proof that gates the Phase B turn-lifecycle
migration. It **must land (and stay green) before any in-tree normalizer code is
deleted.**

## Why

Phase B swaps PwrAgent's hand-rolled `AcpSessionReplayNormalizer` for the kit's
`AcpSessionNormalizer` (`@pwrdrvr/agent-acp`). The kit normalizer was *extracted
from* PwrAgent's, so they should agree — but "should" isn't a gate. This harness
replays the same ACP `session/update` transcripts through both pipelines and
asserts they render the same transcript. Any divergence = drift since
extraction; we catalog and reconcile each one.

## The shape gap (why an adapter + reducer are needed)

The two normalizers have different output models:

| | in-tree `AcpSessionReplayNormalizer` | kit `AcpSessionNormalizer` |
| --- | --- | --- |
| Output | a coalesced `AppServerThreadReplay` snapshot | a stream of `NormalizedThreadEvent` deltas |
| State | accumulates internally | stateless per call; **caller** accumulates |

`agent-core` ships primitives (`createEmptyThread`, `mergeToolCall`) but **no
reducer**. So B1 produces two reusable artifacts that Phase B then ships:

1. **`apps/desktop/src/main/acp/normalized-thread-reducer.ts`** —
   `reduceNormalizedThread(events) → NormalizedThread`. Folds the kit's delta
   events into a coalesced thread (the accumulation the renderer/store needs).
2. **`apps/desktop/src/main/acp/normalized-thread-to-replay.ts`** —
   `normalizedThreadToReplay(thread) → AppServerThreadReplay`. The bridge that
   lets Phase B feed the kit output into today's renderer/persistence unchanged.

Pipeline under test:

```
ACP session/update[]
   ├─ in-tree:  AcpSessionReplayNormalizer.apply(..)         → AppServerThreadReplay   (A)
   └─ kit:      AcpSessionNormalizer.apply(..).events
                 → reduceNormalizedThread → normalizedThreadToReplay → AppServerThreadReplay   (B)
assert canon(A) == canon(B)
```

`canon()` strips ids + timestamps (the two pipelines legitimately mint different
ids) and compares the semantic transcript: message roles/text,
`lastUserMessage`/`lastAssistantMessage`, `threadStatus`, activity
summary/status/details, and plan steps.

Test: `apps/desktop/src/main/__tests__/acp-normalizer-parity.test.ts`
(desktop-main vitest project, node env, runs in CI).

## Status

- [x] **Increment 1 — assistant message streaming + turn lifecycle.** Reducer
      (messages via `agent_message_delta`/`agent_message`, tool-call activities,
      plans, status), adapter, and the parity test. Both **real** normalizers
      agree on the streamed-text case. ✅
- [ ] **Increment 2 — tool calls / commands.** Real captured transcript with a
      `commandExecution` (the smoke eval produces these). Reconcile detail
      mapping (`NormalizedToolKind` → `read|write|command`, command detail,
      status `pending`→`in_progress`).
- [ ] **Increment 3 — plans, files, terminals.**
- [ ] **Increment 4 — reasoning/thought chunks + the `surfaceThoughts` quirk**
      (Qwen=false, others=true) and per-agent quirks (`titleFrom`).
- [ ] **Increment 5 — failures + multi-turn + titles.**
- [ ] **Increment 6 — replay against real captured `.jsonl` fixtures** from the
      smoke eval (`pnpm eval:smoke` writes protocol-capture transcripts;
      `apps/desktop/src/main/testing/fixture-derivation.ts` ::
      `deriveReplayFixtureFromCapture` extracts the session/update sequence).
      Commit a small per-agent fixture set; assert byte-parity per agent.

## Sourcing real transcripts

Every smoke-eval run (`pnpm eval:smoke` / `:ui`, run with `EVAL_KEEP_TEMP=1`)
banks raw ACP `session/update` JSONL under its `captures/` dir. To add a fixture:
filter the JSONL to `method === "session/update"` for one thread, take the
ordered `params.update` objects, and drop them into the harness (or derive via
`deriveReplayFixtureFromCapture`). One representative transcript per agent
(Gemini / Grok / Kimi / Qwen) is the target corpus.

## Known intended divergences

- **ids** — different schemes (in-tree vs kit `assistant:<turn>:<n>`); stripped.
- **timestamps** — `createdAt` differs by clock; stripped.
- **user messages** — the in-tree normalizer ingests the user prompt
  (`recordUserPrompt`); the kit leaves user-message creation to the controller.
  The harness feeds only agent-side updates so both render only assistant
  content. (When real fixtures include `pwragent_user_prompt`, handle
  symmetrically.)

Anything else that differs is **drift to reconcile**, not an allowed divergence.
