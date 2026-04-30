---
date: 2026-04-30
topic: transcript-bottom-glue
---

# Transcript Bottom Glue

## Problem Frame

The desktop thread transcript can stop following the newest content during an active
turn even when the user did not intentionally move away from the bottom. This makes
live agent work feel broken: the user sends a prompt, the agent replies, but the
latest reply, thinking indicator, or pasted screenshot can end up below the visible
viewport.

The existing refresh-model requirements already say that the transcript should
append and auto-scroll when the user is at the bottom. This focused requirement
tightens that behavior into an explicit bottom-glue state so planning does not
recreate the current ambiguous "near bottom" heuristic.

## Existing Context

- `docs/brainstorms/2026-04-18-desktop-thread-refresh-model-requirements.md`
  includes R11-R13 for bottom-following and viewport preservation.
- `apps/desktop/src/renderer/src/features/thread-detail/TranscriptList.tsx`
  already tracks bottom-related refs, saved per-thread viewports, prepend
  anchoring, and a "jump to latest message" control.
- The current implementation recalculates bottom-following from scroll position,
  which is not strong enough for this bug because layout changes, stream growth,
  image loading, or programmatic scroll events can make the view appear unglued
  without a deliberate user scrollbar action.

## Requirements

**Bottom-Glue State**
- R1. Every thread transcript starts with `isGluedToBottom` set to true.
- R2. `isGluedToBottom` may change from true to false only when the user explicitly
  clicks or drags the transcript scrollbar to move away from the bottom.
- R3. Wheel, trackpad, keyboard, programmatic scrolling, content resize, message
  append, pending-status changes, and layout changes must not change
  `isGluedToBottom` from true to false.
- R4. When the transcript is not glued, any user action that scrolls the bottom of
  the newest transcript content into view sets `isGluedToBottom` back to true.
- R5. Clicking the existing jump-to-latest control scrolls to the absolute bottom
  and sets `isGluedToBottom` to true.

**Prompt Send Behavior**
- R6. Sending a prompt in an existing thread scrolls the transcript to the absolute
  bottom and sets `isGluedToBottom` to true before live reply content is rendered.
- R7. The just-sent user prompt, including image attachments or screenshots, must
  be fully visible at the bottom after send.
- R8. A queued or follow-up prompt sent while the transcript was previously unglued
  still reglues the transcript and follows the new turn from the bottom.

**Following Live Content**
- R9. While `isGluedToBottom` is true, every append or size change at the bottom of
  the transcript must keep the viewport at the absolute bottom.
- R10. Bottom-following applies to finalized messages, streaming assistant deltas,
  thinking or planning indicators, activity entries, pending approvals, pending
  user-input forms, command output, rendered images, and any other transcript item
  that can appear or grow at the newest end of the thread.
- R11. Bottom-following must remain correct when content changes height after
  initial render, especially image loading, markdown rendering, code wrapping, and
  collapsible group changes near the bottom.
- R12. When `isGluedToBottom` is false, appending new content preserves the user's
  current reading viewport and keeps the jump-to-latest control available.
- R13. Loading older transcript pages above the viewport preserves the existing
  prepend anchoring behavior and does not force the transcript to the bottom unless
  `isGluedToBottom` is true.

**Ownership and Testability**
- R14. Bottom-following must have one clear owner at the transcript-list level or
  in a small transcript-scroll controller used by that list.
- R15. Callers such as the composer and thread view may request "reglue and scroll
  to bottom" for user-send events, but they must not need to remember each low-level
  moment when streamed content or resized content requires another scroll.
- R16. E2E coverage must reproduce the failure mode: send a prompt, receive multiple
  replies or live updates, and verify the newest transcript content remains visible
  at the bottom without any intentional user scrollbar interaction.
- R17. E2E coverage must include at least one bottom-growing item that can change
  height after initial render, such as an image attachment, screenshot, markdown
  block, or pending indicator.
- R18. E2E coverage must also prove the escape hatch: after explicit scrollbar
  interaction moves the user away from the bottom, live appends preserve the reading
  viewport until the user returns to the bottom or sends a new prompt.

## Success Criteria

- After the user sends a prompt, the transcript remains scrolled to the absolute
  bottom through thinking, streaming, final replies, and image-height changes.
- The latest visible transcript item is never hidden below the viewport while
  `isGluedToBottom` is true.
- The screenshot-backed failure case from the desktop E2E run is covered by a
  regression test that fails before the fix and passes after it.
- Users can still intentionally read older content by using the transcript scrollbar,
  and new activity does not pull them away until they return to the bottom or send
  another prompt.

## Scope Boundaries

- This work does not redesign thread refresh, transcript storage, or app-server
  event contracts.
- This work does not require transcript virtualization unless planning discovers
  that the current DOM list cannot reliably support the required behavior.
- This work does not add new visible product copy beyond the existing jump-to-latest
  affordance.
- This work does not change markdown, image, activity, approval, or pending-input
  rendering except as needed to make their size changes participate in bottom glue.

## Options Considered

| Option | Fit | Tradeoffs |
| --- | --- | --- |
| Local transcript-scroll controller | Best fit | Preserves current renderer structure, keeps dependency surface small, and can encode the stricter "only scrollbar action unglues" rule directly. Requires careful tests around event intent and ResizeObserver/layout changes. |
| `use-stick-to-bottom` | Plausible fallback | Purpose-built for AI chat, zero dependency, and ResizeObserver-aware. Its default behavior lets user scrolling cancel stickiness, which is broader than the required scrollbar-only unglue rule. |
| `react-scroll-to-bottom` | Plausible but older fit | Provides sticky state, scroll-to-bottom hooks, and a follow button model. It is built around stickiness/position checks and recurring checks, not this product's stricter explicit-glue state. |
| `react-virtuoso` | Overpowered for now | Has `followOutput`, bottom-state callbacks, inverse scrolling support, and virtualization. It would be useful if transcript size/performance becomes the primary problem, but it is a larger rewrite than this bug needs. |
| TanStack Virtual | Poor first step | Excellent low-level virtualization primitives, but bottom-following chat behavior would still need custom glue logic on top. |

## Key Decisions

- Use an explicit bottom-glue state instead of deriving follow behavior solely from
  current distance from the bottom.
- Treat prompt send as an explicit user intent to return to the bottom and follow
  the new turn.
- Prefer a local transcript-scroll controller for the first fix because the product
  rule is stricter than the default behavior of the researched packages.
- Keep the existing "jump to latest" affordance, but make it a regluing action.

## Dependencies / Assumptions

- The browser can distinguish explicit scrollbar interaction well enough for this
  product requirement, likely by inspecting pointer interaction with the scroll
  gutter/thumb area during planning.
- ResizeObserver is available in the Electron renderer and can be used to keep the
  viewport pinned during bottom content growth.
- The existing E2E harness can drive programmatic transcript appends and observe
  `scrollTop`, `scrollHeight`, and visible transcript content deterministically.

## Sources

- React Virtuoso documents `followOutput`, `atBottomStateChange`, and bottom
  thresholds for list bottom-following:
  https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/
- `use-stick-to-bottom` documents an AI-chat-oriented hook with ResizeObserver-based
  content resize handling and user-scroll cancellation:
  https://github.com/stackblitz-labs/use-stick-to-bottom
- `react-scroll-to-bottom` documents sticky state, scroll-to-bottom hooks, and a
  `scroller` callback that runs when sticky content changes size:
  https://app.unpkg.com/react-scroll-to-bottom-updated%404.2.1-main.b8336f2/files/README.md

## Outstanding Questions

### Resolve Before Planning

None.

### Deferred to Planning

- [Affects R2][Technical] What exact DOM event test should classify "user clicked
  the scrollbar" in Electron across overlay and non-overlay scrollbar styles?
- [Affects R9][Technical] Should bottom pinning use direct `scrollTop =
  scrollHeight`, a bottom sentinel with `scrollIntoView`, ResizeObserver, or a
  combination?
- [Affects R16][Technical] Which existing replay fixture should be extended, or
  should a new focused replay fixture be added for send-plus-live-bottom-following?

## Next Steps

-> `/prompts:ce-plan` for structured implementation planning
