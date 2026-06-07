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
- [x] **Increment 2 — tool calls + plans (structural parity).** Read tool call,
      plan-then-tool-call, ACP content-block chunks. **Structural** parity holds
      (entry types + order, activity summary + status, plan steps, per-detail
      label + count). The harness surfaced field-level tool-detail divergences
      (below) — cataloged for B2. Fixed one adapter bug (the in-tree keeps tool
      status on the activity, not the detail; the adapter no longer sets
      `detail.status`). ✅
- [x] **Increment 6 — real captured transcripts, all four ACP agents.**
      Redacted real transcripts from the smoke eval
      (`fixtures/acp-transcripts/{gemini,grok,kimi,qwen}-build.json`) assert
      transcript-level parity per agent. This is what surfaced the broader
      tool-detail divergence (below). See "Real-data validation". ✅
- [ ] **Increment 3 — files, terminals + command output/exitCode.**
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

## Real-data validation (the result, and a correction)

Ran a **full-fidelity** parity check (every field, ids/timestamps aside) over
the smoke eval's real captures — all four ACP agents, 3 sessions each, **11
diverging sessions, 90 differing entries**. What holds and what doesn't:

**Transcript-level parity holds across all four agents:**

- **Zero entry-count mismatches.** Same number + order of entries everywhere.
- **Zero message divergences.** Every assistant/user message text is
  byte-identical.
- **Every divergence is confined to a tool-call `activity`'s per-detail fields.**
  Messages, plan steps, entry structure/order, and activity-level
  summary/status all agree.

**Correction to an earlier note:** Gemini's transcripts (simple file reads) made
the per-detail divergence look like just two fields (`path` + a conflated
`command`). The richer agents (Grok/Kimi/Qwen) show it's broader — per
tool-call **detail**, the two pipelines also disagree on `kind` (in-tree
`toolDetailKind(kind, path)` vs kit `inferToolKind(name)`) and on the
`command.displayCommand` formatting, in addition to the dropped `path`. So the
reconciliation surface is the **whole tool-detail object**, not three tidy
fields.

The committed parity tests therefore assert **transcript-level** parity
(messages, structure/order, activity summary + status + detail count) and scope
out the per-detail fields, which are tracked below. This is still the core
KTD-P3 reassurance — the user-visible transcript is reproduced losslessly; what
needs reconciling is how each tool detail is *rendered*.

## Cataloged divergences (require reconciliation before B2 ships)

Found by the harness. The tool-detail comparison now asserts per-detail
**`label` + `path`** (both match across all four agents' real transcripts); the
remaining scoped-out fields (`kind`, `command`) are below.

1. **`read`/file tool location path dropped — ✅ RESOLVED.** Was: the kit's
   `NormalizedToolCall` had no `locations`/`path`, so file paths were lost.
   Fixed upstream in [pwrdrvr/agent-kit#1](https://github.com/pwrdrvr/agent-kit/issues/1)
   (agent-core 0.2.0 adds `NormalizedToolCall.locations`); consumed here by
   bumping `@pwrdrvr/agent-acp` → `^0.11.0` and reading
   `tool.locations[0].path` in `normalized-thread-to-replay.ts`. **`path` is now
   asserted in the parity canon** and matches on real data for all four agents.
2. **Command conflation on non-command tools — ✅ RESOLVED.** agent-acp 0.11.0 no
   longer folds a read's title into `command`, so the adapter surfaces the kit's
   `command` faithfully (no shim needed).
3. **Tool-kind inference differs — OPEN (scoped out).** The in-tree
   (`toolDetailKind(kind, path)`) and the kit (`inferToolKind(name)`) land on
   different classifications, e.g. Qwen's `ReadFile` → kit `write` vs in-tree
   `command`. Neither is obviously "read"; reconcile the mapping (adapter or
   kit) — not information-losing.
4. **`command.displayCommand` differs — OPEN (scoped out).** The in-tree
   synthesizes/derives a command string the kit doesn't (e.g. a running
   `ls -d node_modules` from the label), and produces a **spurious** command
   (`"tool call update"`) for Qwen's snake_case `tool_call_update` that the kit
   correctly omits. The kit is arguably *more* correct here; likely an
   accept-and-move-on, not a kit fix.

Tracking: these gate **B2** (adopt `AgentBackend`/the kit normalizer for the
live ACP path). Resolve via a kit patch + republish, or a documented
accepted-loss + adapter shim, before deleting `acp-session-normalizer.ts`.
