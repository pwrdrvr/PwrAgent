# Star Map Floating Chat Cards — Implementation Plan

- **Date**: 2026-08-06
- **Branch**: `star-map/chat-cards`
- **Base**: `origin/main` (post #1268)
- **Predecessor**: [2026-08-05-003-feat-star-map-mission-control-plan.md](2026-08-05-003-feat-star-map-mission-control-plan.md)

## Operator requirement

Clicking a thread card in the Star Map currently opens the **entire remote
viewer window** for that instance. That is not what was asked for. The
requirement, verbatim in intent:

> I wanted in-star-map float-over "chat cards" … you can have one of these
> chat cards popup and you can move it around, resize it. You can open
> another one too. You can open as many as you have screen real-estate to
> fit.

Plus a **compact composer**: the full composer's control row is too tall for
a floating card, so secondary controls consolidate under a kebab and the
model / reasoning-effort indicators become right-aligned placeholder text
inside the input rather than separate chips.

## Correction to the earlier three-item split

This work was previously scoped as **three** stacked PRs, the first being
"make remote threads selectable in-place (auto-pin or snapshot merge)".
Reading the code closed that question: **item 1 is not needed and will not
be built.**

`useThreadSessionState` is parameterized by a `NavigationThreadSummary`
passed in as a prop — not by a global selection — and it already derives the
federation target from that summary:

```ts
// apps/desktop/src/renderer/src/lib/useThreadSessionState.ts:3789
federationTarget: targetThread.federation?.ref.target
  ?? readRendererFederationTarget(),
```

`StartTurnRequest.federationTarget` is likewise optional-and-honored
(`packages/shared/src/contracts/agent.ts:241`), and the established
call-site idiom across `App.tsx` is the same `thread.federation?.ref.target
?? readRendererFederationTarget()` fallback.

The selectability blocker was an artifact of the *single mounted ThreadView*
design: `navigation.selectThread` looks the key up in the snapshot, so a
thread absent from the snapshot cannot be selected. Multi-card explicitly
requires **per-card session state anyway**, and once each card owns its own
hook instance and receives its thread summary directly from the map's data,
there is nothing left to select. No pinning, no snapshot merge, no new
protocol.

Net: **two units, not three.**

## Non-goals

- Reusing `ThreadView` (3,636 lines, ~150 props) or the full `Composer`
  (11,952 lines) inside a card. Cards compose `TranscriptList` plus a
  purpose-built compact composer.
- Persisting card geometry across app restarts. Cards are ephemeral session
  furniture; the *thread arrangement* is the thing that syncs across the
  federation, and that already shipped.
- Changing what the instance-card click does. Clicking an **instance** still
  opens that instance's viewer window; only **thread** cards float.

## Unit 1 — Floating chat card surface

Subsumes the old items 1 and 3.

- `StarMapChatCardHost` — owns the open-card list, z-order, and cascade
  placement for new cards. Lives above the canvas so cards do not pan or
  zoom with the star field (they are windows over the map, not objects in
  it).
- `StarMapChatCard` — one card: title bar (thread title, instance watermark,
  close), drag to move, resize from the bottom-right corner, click to raise.
  Clamped to the viewport so a card can never be dragged fully off-screen.
- Per-card `useThreadSessionState({ desktopApi, thread })` supplies entries,
  pending request, busy state, and optimistic message insert. Remote and
  local threads take the identical path.
- Transcript renders through the existing `TranscriptList`.
- Minimal send path: text input, send, and interrupt-while-busy. Enough to
  hold a conversation; the full control surface lands in Unit 2.
- Star map thread click opens a card instead of `openFederationWindow`.

**Geometry decisions**: default card 420×520, min 320×280. Cascade offset
28px per open card, wrapping after 6. Cards clamp on window resize.

## Unit 2 — Compact composer variant

- `compact` variant of the composer control row: primary actions stay
  visible (send, interrupt, attach); secondary actions (execution mode,
  branch, skills, review, compaction, scheduled actions) consolidate under a
  single kebab menu.
- Model and reasoning effort render as **right-aligned placeholder text
  inside the input**, not as chips — they read as ambient state, and they
  cost zero vertical space.
- Swapped into the card in place of Unit 1's minimal input.

Whether this is a `compact` prop threaded through `Composer.tsx` or a
separate small component that shares the send/queue hooks is deliberately
left to implementation — 12,000 lines is enough that the answer depends on
how separable the control row turns out to be. Decide it in Unit 2, record
it here.

## Verification

Per unit: `pnpm test` (root, focused first), `pnpm --filter
@pwragent/desktop typecheck`, `pnpm lint:colors`, `pnpm lint:boundaries`,
`pnpm lint:eslint`. New renderer tests for card geometry (cascade, clamp,
raise) and for the card's federation-target derivation.

## Progress

- [ ] Unit 1 — floating chat card surface
- [ ] Unit 2 — compact composer variant
