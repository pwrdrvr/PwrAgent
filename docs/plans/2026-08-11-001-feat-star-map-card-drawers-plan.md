# Star Map Card Drawers and Markdown Cards — Implementation Plan

- **Date**: 2026-08-11
- **Branch**: `claude/star-map-card-drawers`
- **Base**: `claude/star-map-load-card-overview` (#1485), itself stacked on
  `claude/star-map-card-grouping-dca8d7` (#1476)
- **Predecessor**: [2026-08-06-001-feat-star-map-chat-cards-plan.md](2026-08-06-001-feat-star-map-chat-cards-plan.md)
- **Issue**: [#1481](https://github.com/pwrdrvr/PwrAgent/issues/1481)

## Operator requirement

Three asks, all from driving the map in #1476:

> I think we need to be able to click a little "right bar open" on these
> chats that opens the right bar tabs next to the chat so I can see like
> what sub-agents, what cost, what dates was it opened.. you know... the
> whole nine yards.

> Oh oh oh... and give me a open the bottom edge to get my PTY!!!

> If we didn't already do "open this MD file" viewer in star map we should
> do that... should be a card like the chats.

## Where this starts from

#1476 made chat cards objects **in** the galaxy: they render inside
`.star-map__canvas`, pan and zoom with it, open beside the thread card they
belong to, and tether back to it. Three separate bugs came out of that one
change, all the same shape — the canvas's global handlers started seeing
chat card events:

| Handler | Symptom | Fix |
|---|---|---|
| `startCanvasPan` | Dragging a card dragged the galaxy too | `.star-map-chat-card` named in `shouldStartCanvasPan` |
| viewport `wheel` | Scrolling a transcript panned the map | `shouldPanOnWheel`, with pinch deliberately exempt |
| WASD flight (#1477) | Typing `w` would fly the camera | already guarded upstream |

**Assume the fourth exists.** Anything added here that grows a new
interactive surface inside the canvas — a rail with its own scroll, a
terminal that wants every keystroke — should be checked against every
global handler on the viewport before it is called done.

## Item 1 — Context rail drawer (right edge)

A toggle in the chat card's title bar opens the existing
`ThreadContextPanel` tabs beside the transcript: thread info, pricing,
sub-agents, edits, tool calls, PRs, linked projects, actions.

**Reuse `ThreadContextPanel`.** Of its ~40 props only four are required
(`backends`, `pinned`, `activeTab`, `onActiveTabChange`), and the panels
largely fetch their own data from `desktopApi`, so a first pass should
light up most tabs from `thread` + `desktopApi` alone. Tabs that stay
empty because their data is threaded down from `ThreadView` are a second
pass, not a blocker.

### The part that is not a lift

The rail is a **controlled** component in `ThreadView`: width lives on
`.thread-view` as `--context-rail-width`, and the chat column and header
reserve the derived `--context-rail-effective`. A chat card is a floating
object with its own bounds and no header, so it needs its own width source
and its own reserved gutter. This is the actual work.

### Decide before building

- **Widen the card, or narrow its transcript?** Widening reads better and
  matches the full thread view, but it changes the card's rect — which the
  tether (`chatTethers` in `StarMapScreen`) and the overlap step in
  `placeChatCardBesideAnchor` both read. Narrowing keeps the rect still and
  costs transcript width, which is the thing the card exists to show.
- `RAIL_MIN_WIDTH` is 300px against a 420px default card. A widened card is
  720px+ in canvas units; check what that looks like at 0.5 zoom, where the
  overview threshold sits.

## Item 2 — PTY drawer (bottom edge)

Drag or click the card's bottom edge open to get the thread's integrated
terminal, reusing `IntegratedTerminal` from `thread-detail`.

**Test the terminal under a scale transform on day one, before any drawer
UI exists.** Chat cards live inside the zoomed canvas; xterm sizes by
character cells measured in pixels, and a mismeasure inside a scaled
ancestor changes the whole approach — counter-scale the drawer, or gate it
to zoom 1. This is the highest-risk unknown in the issue and it is cheap to
answer with a throwaway spike.

Also decide what a terminal at 0.4 zoom should do. It is probably
unreadable; "looks bad and that is accepted" is a legitimate answer, but it
should be a decision rather than a discovery.

## Item 3 — Markdown cards

There is no markdown viewer on the map today —
`MarkdownFilesWindow` in `thread-detail` is a separate window, not a card.
Open an `.md` file as a card like the chats: same drag, same resize, same
canvas anchoring, same tether treatment where it has a thread to tether to.

Most of the machinery already exists and should be shared rather than
copied:

- `useStarMapChatCards` owns the open set, cascade/anchored placement,
  z-order and raise. A markdown card is another entry in that model, not a
  parallel one — expect to generalize the entry type rather than fork the
  hook.
- `star-map-chat-card-geometry.ts` is already pure and card-kind agnostic:
  `placeChatCardBesideAnchor`, `clampChatCardRect`, `resizeChatCardRect`,
  `chatCardEdgeToward`.
- `ThreadMarkdown` renders the content.

Open question: what opens one? Candidates are a card kebab entry on a
thread whose worktree has markdown files, the intake dialog, and drag-drop
onto the canvas. Not decided here.

## Sequencing

1. **Rail drawer.** Lowest risk, and it forces the card-rect question that
   the PTY drawer also depends on.
2. **PTY drawer**, after the xterm-under-scale spike answers whether it is
   a drawer or a zoom-gated drawer.
3. **Markdown cards.** Independent of both; can be pulled forward if the
   drawers stall on the rect decision.

## Testing notes

Traps that have already cost time on this surface:

- Run the suite under the repo's pinned Node (24.14.1). Under Node 26 the
  whole vitest run fails with bogus `localStorage` errors.
- Re-query elements at click time in star map screen tests
  (`await screen.findByRole(...)` then `fireEvent.click(screen.getByRole(...))`).
  The map re-renders on card measurement, and a node captured across an
  `await` is detached — the click silently does nothing.
- Wait for federation health before asserting anything about a selection:
  card keys name their instance, and the map drops a selection swept
  against the placeholder id when the durable one lands.
- Do not run the Electron/Playwright E2E suite on the operator's Mac; use
  the PwrSuiteLab macOS Tart guest.
