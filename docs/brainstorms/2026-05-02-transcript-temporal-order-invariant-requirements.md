---
date: 2026-05-02
topic: transcript-temporal-order-invariant
---

# Transcript Temporal Order Invariant

## Problem Frame

The desktop transcript is still able to display later tool/activity groups above
earlier assistant text. In thread `019de585-735e-7aa0-82d7-469a6a32eb80`,
protocol logging for the 9:04-9:06 AM EDT window shows agent messages and tool
activity interleaved in real event order, but the UI screenshot shows later
activity groups rendered above earlier assistant messages. This violates the
basic chat contract: the transcript is a temporal record first, and grouping is
only a presentation detail.

The failure matters more than normal visual polish because it destroys trust in
the transcript. A user watching a live demo must be able to assume that if an
item is visually above another item, it happened no later than the item below it,
except for explicitly older history loaded above the viewport.

## Evidence

- The protocol capture
  `apps/desktop/.local/protocol-captures/2026-05-02T02-31-52-380Z-codex-full-access.jsonl`
  records turn `019de8c9-b96b-7340-b78e-39bf6fe4ecf8` in temporal sequence:
  an agent message begins around 9:04:12 AM EDT, followed by later command
  activity around 9:04:19 AM EDT, more agent messages around 9:04:43 and
  9:05:09 AM EDT, and additional tool activity around 9:05-9:06 AM EDT.
- The external Codex rollout for the same thread preserves those event
  timestamps in order; planning can use the protocol capture above as the
  repo-local evidence source.
- The renderer grouping helper currently groups active work by filtering all
  work entries for a turn, not by checking bottom-contiguous adjacency first
  (`apps/desktop/src/renderer/src/features/thread-detail/transcript-render-items.ts`).
- Live session state merges hydrated response entries and optimistic live
  entries in several places, including agent-message deltas, tool starts, item
  completions, and turn completion (`apps/desktop/src/renderer/src/lib/useThreadSessionState.ts`).
- `thread/read` hydration maps all items in a turn to the turn-level timestamp,
  so it cannot by itself recover per-item temporal order after live optimistic
  entries have separate event times
  (`apps/desktop/src/main/codex-app-server/client.ts`).

## Requirements

**Hard Ordering Invariant**
- R1. The transcript render order must be globally nondecreasing by the canonical
  event order for all visible entries in a thread.
- R2. A later tool/activity group must never render above an earlier user or
  assistant message solely because the entries share a turn id.
- R3. Grouping, collapsing, summarizing, and "same turn" affinity must not move
  any entry across text, plan, review, approval, or command-output entries.
- R4. If event timestamps are incomplete or equal, the app must use a stable
  append sequence captured when the event was observed, not re-sort by type,
  turn, role, or grouping convenience.

**Grouping Semantics**
- R5. Work grouping may only combine entries that are already adjacent in the
  canonical transcript order.
- R6. Completed work groups may remain collapsed, but the group placeholder must
  occupy the position of the first grouped entry and may only contain entries up
  to the last contiguous grouped entry before the next non-grouped transcript
  item.
- R7. Active work grouping may only append to the most recent bottom-contiguous
  active work group when no text or other transcript item has appeared after
  that group.
- R8. Once assistant text appears after a tool group, later tool activity must
  form a new group below that assistant text, even if it belongs to the same
  turn.

**Hydration And Live Merge**
- R9. Live optimistic entries and hydrated `thread/read` entries must merge into
  a single ordered ledger before rendering.
- R10. Hydration must not replace precise live event order with coarser
  turn-level timestamps when live per-item ordering is already known.
- R11. Duplicate suppression must preserve the surviving entry's earliest known
  event position and must not reinsert the survivor at the bottom or at a
  turn-derived position.
- R12. Turn completion must preserve the relative order of all retained
  optimistic activity and all materialized assistant messages.
- R21. Once an edited-file or changed-file transcript entry with inline diff
  content has been shown, later hydration, duplicate suppression, or refresh
  churn must not remove that file list or diff from the chat.
- R22. If a hydrated `thread/read` response temporarily includes an edited-file
  diff and a later response omits it, the renderer must retain the previously
  visible diff activity unless a newer equivalent diff activity replaces it.
- R23. End-of-turn transcript state should expose a durable modified/added/
  deleted file summary with inline diff access, so the user can inspect the
  final changes without relying on transient live protocol updates.
- R24. An active turn may render at most one live elapsed-time indicator such as
  `Working for ...` in the transcript; older active work groups must not each
  keep their own updating timer.
- R25. Durable edited-file diff carry-forward is scoped to the current/latest
  turn only; preserving current turn diffs must not resurrect edited-file
  summaries from older turns at the bottom of the chat.
- R26. Edited-file and changed-file diff activities should render as top-level
  transcript items with file counts and line-change summaries visible without
  first expanding a generic work group such as `More work`.

**Testing Gates**
- R13. Unit tests must fail when any visible transcript item has an ordering key
  earlier than the item above it, after render-item construction.
- R14. Renderer tests must include the real failure shape: assistant commentary,
  later tool group, assistant commentary, later tool group, all in one turn.
- R15. E2E/replay tests must assert DOM order for both collapsed and expanded
  activity groups.
- R16. E2E/replay tests must include hydration churn: live optimistic entries are
  present, `thread/read` returns coarser persisted entries, and the rendered DOM
  still preserves the original event order.
- R17. Any test helper that builds transcript fixtures must make event order
  explicit, preferably with a monotonic `sequence` or `observedAt` field, so
  tests cannot accidentally pass by array order alone.

**Diagnostics**
- R18. Development builds should log or fail fast when the renderer receives
  entries whose canonical order would place a later visible item above an
  earlier visible item.
- R19. When duplicate React keys are detected in transcript render items, the log
  must include the entry ids, turn ids, render-item ids, and canonical order keys
  involved.
- R20. Protocol-capture analysis should be able to produce a compact transcript
  order report for one thread id and turn id, so future reports can be compared
  against DOM order without manual log spelunking.

## Success Criteria

- The 9:04-9:06 AM EDT sequence from thread
  `019de585-735e-7aa0-82d7-469a6a32eb80` renders in the same order as the
  protocol events: assistant text, later tools, assistant text, later tools,
  assistant text.
- No unit or E2E test can pass if a visible entry appears above an earlier
  visible event.
- Collapsing or expanding work groups changes detail visibility only, not the
  relative position of any group or transcript message.
- Hydrating from `thread/read` during or after an active turn does not reshuffle
  already-observed live transcript items.
- Edited-file and changed-file diff entries remain visible after live updates,
  hydration catch-up, and later refreshes that omit the diff from the backend
  response.
- Active turns do not leak multiple simultaneous `Working for ...` indicators
  when assistant text and tool activity are interleaved.
- The bottom of the transcript shows only the current turn's edited-file diff
  summary, and that summary is directly visible at the top level.

## Why We Got This Wrong

- We treated "same turn" as a stronger organizing principle than temporal
  transcript order. That makes the UI feel tidy in simple cases but fails as
  soon as one turn alternates text, tools, and more text.
- We have multiple ordering sources: protocol notification order, optimistic
  renderer insertion order, `createdAt`, turn-level `startedAt`, persisted
  `thread/read` item order, and grouping order. No single canonical ledger owns
  the final transcript order.
- Hydration loses precision because some persisted entries only carry turn-level
  time. When those entries are merged with live optimistic entries that have
  later observed times, the merge logic can make plausible but wrong choices.
- Existing tests cover several local cases, including collapsed tool activity,
  but they do not assert the universal invariant across the complete live plus
  hydration pipeline.
- Grouping logic has been allowed to be clever. The durable rule needs to be
  dumb: grouping can summarize adjacent entries, but it cannot move entries.

## Scope Boundaries

- This work does not redesign transcript styling.
- This work does not require transcript virtualization.
- This work does not require changing backend protocol semantics if the desktop
  layer can maintain a canonical observed order.
- This work should not depend on a human visually noticing order drift; failing
  tests and development diagnostics are in scope.

## Key Decisions

- Time order is the primary product contract: it overrides role grouping,
  turn grouping, work grouping, collapse state, and hydration convenience.
- The transcript needs a canonical ordered-entry ledger before render grouping.
  Grouping should consume that ledger and produce placeholders without changing
  order.
- Tests should enforce the invariant at multiple levels: merge unit, render-item
  unit, and replay/E2E DOM order.

## Outstanding Questions

### Resolve Before Planning

- None.

### Deferred to Planning

- [Affects R4, R9-R12][Technical] Where should the canonical order key live:
  shared app-server entry contract, renderer-only session state, or a small
  transcript ledger adapter between hydration and rendering?
- [Affects R16][Technical] Should the regression replay be derived from the
  captured protocol file for thread `019de585-735e-7aa0-82d7-469a6a32eb80`, or
  should it be a smaller synthetic fixture that preserves the same failure
  shape?
- [Affects R18-R20][Technical] Should out-of-order detection throw in tests only
  and warn in development, or should it hard-fail in development builds too?

## Next Steps

-> /prompts:ce-plan for structured implementation planning.
