---
title: Unified thread row chip flow (emojis, messaging bindings, PRs, branch)
type: fix
status: completed
date: 2026-05-05
supersedes:
  - U3.2 chip-rendering bits in docs/plans/2026-05-04-001-feat-desktop-design-overhaul-plan.md
  - U3.3 chip-rendering bits in docs/plans/2026-05-04-001-feat-desktop-design-overhaul-plan.md
  - U4.3 chip-rendering bits in docs/plans/2026-05-04-001-feat-desktop-design-overhaul-plan.md
---

# Unified thread row chip flow

## Overview

Today every kind of chip on a thread row was bolted on independently:
metadata chips (`ThreadMetaChips`) live in their own `<span>`, PR chips
in their own wrapper, messaging binding chips in another wrapper, and
emoji reactions in a third. Each ships with its own positioning rules
and one-off margins. The result keeps breaking under small changes
(see PR [#187](https://github.com/pwrdrvr/PwrAgent/pull/187) commit
history for the recent thrash):

- The binding chip was *inside* the row's main `<button>` and got eaten
  by nested-button HTML rules.
- Moving binding chips out of the button made them stack as a separate
  line, which pushed the reaction `+` button into the chip's row.
- Absolute-positioning the binding chip back on top of the row hides
  it under the `+` button when both exist.

This plan replaces all of that with a single, ordered, wrapping
chip flow that renders every chip as a sibling — the same way a
`flex-wrap` toolbar handles items of varying widths in any other
modern UI.

## Problem Statement / Motivation

### What broke

From [the design screenshot the user shipped](#) (sidebar mockup,
2026-05-05): every chip on a thread row sits in one continuous,
wrapping line directly under the title. There's no special slot for
PR chips vs binding chips vs reactions. The emoji "add" affordance is
an emoji glyph (a 🙂 face), not a `(+)` button, and it floats at the
end of the chip row — wrapping onto the next line when it doesn't
fit, exactly like every other chip.

### What's in the code today

- [ThreadRow.tsx:142](apps/desktop/src/renderer/src/features/navigation/ThreadRow.tsx)
  renders four sibling chip groups inside (and one outside) the main
  `<button>`:
  1. `<ThreadMetaChips>` (agent type, mode, worktree/local, branch,
     drift) — `<span class="thread-row__meta">` with `flex-wrap: wrap`,
     **inside** the button.
  2. `<span class="thread-row__pr-chips">` — separate flex-wrap
     container, **inside** the button. Each PR chip is a real
     `<button class="pr-chip">` ([PrChip.tsx:18](apps/desktop/src/renderer/src/features/pr-status/PrChip.tsx)).
  3. `<div class="thread-row__binding-chips">` — separate container,
     **outside** the button (moved out to dodge nested-button click
     eating). Each binding chip is a real `<button>`.
  4. `<div class="thread-row__reactions">` — separate container,
     **outside** the button. Each reaction is a real `<button>`. The
     add-reaction trigger is a real `<button>` rendering literal
     `<span aria-hidden="true">+</span>`
     ([ThreadRow.tsx:216](apps/desktop/src/renderer/src/features/navigation/ThreadRow.tsx#L216)).

Two unrelated CSS hacks try to keep these four containers from
overlapping:

- [app.css:867](apps/desktop/src/renderer/src/styles/app.css#L867) —
  `.thread-row-shell:has(.thread-row__binding-chips) .thread-row {
  padding-bottom: 36px; }` reserves room.
- [app.css:261](apps/desktop/src/renderer/src/styles/app.css#L261) —
  `.thread-row__binding-chips { position: absolute; left: 14px;
  bottom: 10px; ... }` re-overlays the chip back into the row.

Every time we touch a chip group, one of these escapes its lane and
overlaps another.

### Root cause

There is no shared concept of "the row's chip area." Each chip type
ships its own container with its own positioning rules. The fix is to
collapse them into one container and let `flex-wrap` do the work the
CSS spec was designed for.

## Proposed Solution

One chip flow per row. Wrap. Order. No special positioning.

### Single `.thread-row__chips` container

Replace the four separate containers with **one**:

```tsx
<span className="thread-row__chips">
  {metaChips}
  {prChips}
  {bindingChips}
  {reactionChips}
  {addReactionChip /* always last when canReact */}
</span>
```

CSS:

```css
.thread-row__chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  /* No position:absolute. No special padding. No :has() hacks. */
}
```

### Chip ordering (left → right, then wrapping onto next line)

1. **Agent type** (Codex / Grok)
2. **Mode** (Plan / Read-only / Full Access) when present
3. **Linked directory kind** (worktree / local / workspace) — when
   `includeLinkedDirectories` is on
4. **Branch** (with branch icon, monospace text)
5. **Branch drift** ("now <observedBranch>") when drifted
6. **PR chips** (one per linked PR; `#NNN` or `org/repo#NNN`)
7. **Messaging binding chips** (one per active binding; platform icon
   + optional conversation title)
8. **Emoji reactions** (in insertion order)
9. **Add-reaction chip** — always the *last* item when `canReact`

This order matches the user's directive in the planning request:
*"agent type, worktree/local, branch, pr chips, message binding chips,
emojis, emoji adder."*

### Add-reaction is a real emoji, not "(+)"

Render a slightly-grayed smiley face glyph (`🙂` — same one used by
GitHub's add-reaction affordance). Reactions are already explicitly
exempted from the no-emoji-as-icon rule by
[ReactionPicker.tsx:10](apps/desktop/src/renderer/src/features/navigation/ReactionPicker.tsx#L10),
so this is consistent with the existing "reactions are content" rule
in `docs/UI-THEME.md`.

The chip itself is the same chip primitive as the others (same height,
same border-radius, same hover treatment). Only the inner glyph
differs.

### Click handling: spans, not nested buttons

The thread row's main click target is the row-wide `<button
class="thread-row">` that selects the thread. Today we have **real
nested `<button>` elements** for PR chips, binding chips, reactions,
and add-reaction. That's invalid HTML and is the original cause of
the click-eating bug.

Fix: every interactive chip becomes a `<span role="button" tabIndex=0>`
with `onClick` + `onKeyDown` (Enter / Space) handlers that call
`event.stopPropagation()`. This is the **same pattern already used by
the path-copy chips** in
[ThreadMetaChips.tsx:36](apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx#L36)
— proven to work, no nested-button warning from React.

### Compact rows (DirectoriesList)

`thread-row--compact` (used in
[DirectoriesList.tsx](apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx))
flips the row to `flex-direction: row`. The single chip flow still
applies — the chips wrap onto a second line when the row narrows,
which is what they already do today via `flex-wrap: wrap` inside
`.thread-row__meta`. No special compact rules.

### What gets deleted

From `app.css`:

- `.thread-row__pr-chips` rules (lines 1336-1341).
- `.thread-row__binding-chips` rules (lines 261+).
- `.thread-row-shell:has(.thread-row__binding-chips) .thread-row {
  padding-bottom: 36px; }` (lines 867+).
- `.thread-row__reactions` and the per-reaction button rules
  (lines 919+, 936+, 962+, 969+, 977+).
- `.thread-row__add-reaction` rules (it's now a chip).
- `.thread-row__reaction-picker-wrap` (the picker portal mounts via
  `ReactionPicker`'s own portal — the wrap is only for absolute
  positioning of a hidden picker, no longer needed).

From JSX:

- The four separate chip containers in
  [ThreadRow.tsx:142-231](apps/desktop/src/renderer/src/features/navigation/ThreadRow.tsx).

## Technical Considerations

### Architecture impact

- **One container, one set of rules.** Future chip additions (e.g.
  the "ignored sender" badge floated in U4.4 follow-ups) drop in
  trivially.
- **`flex-wrap: wrap` does layout.** No JS measurements, no
  intersection observers, no `:has()` hacks.
- **No nested `<button>` elements** anywhere in `ThreadRow`. The row
  itself stays a `<button>` for "select thread"; everything inside is
  a span.

### Accessibility

- **Tab order.** Each `role="button"` chip with `tabIndex={0}` enters
  the keyboard tab order. In a long sidebar with many chips, this is
  a lot of tab stops. **Decision**: only chips with their own click
  behavior (PR chip → opens URL, binding chip → opens menu, reaction
  → toggles, add-reaction → opens picker) are tabbable. Static chips
  (agent type, mode, branch label) stay as plain spans without
  `tabIndex`.
- **Screen-reader semantics.** The row `<button>` already has
  `aria-pressed={selected}` and a label derived from
  `props.thread.title`. Each interactive chip carries its own
  `aria-label` (already true for PR chips, binding chips, reactions).
- **Focus rings.** A 2px outline (`outline: 2px solid var(--accent);
  outline-offset: 2px`) on `:focus-visible` for chip spans, matching
  the existing `tooltip-target:focus-visible` rule.

### Performance

- The renderer cost is the same — same number of DOM nodes, same
  React reconciliation. We're moving rules around, not adding work.
- `flex-wrap` is GPU-friendly on macOS. No layout thrash.

### Visual consistency

All chips share the same primitive class (`thread-row__chip`) — same
24px height, 12px border-radius, 6px internal gap, 8px padding,
12px font, 500 weight. Variant classes (`--backend`, `--mode`, `--mono`,
`--muted`, `--approval`, `pr-chip--<state>`) override only color and
border. The reaction chip and add-reaction chip should adopt the same
primitive (currently they're 22-24px depending on glyph metrics).

## System-Wide Impact

### Interaction graph

- `ThreadRow` is rendered by `InboxList`, `RecentsList`,
  `DirectoriesList` — all three pass the same set of callbacks. No
  consumer needs to change.
- `ReactionPicker` portals into the document body and anchors via
  `anchorRef`. The anchor element changes from a `<button>` to a
  `<span>` — but `anchorRef` is typed `RefObject<HTMLElement>` so this
  works without a signature change.

### Error & failure propagation

No new failure modes. Click handlers continue to call the same
callbacks (`onSelectThread`, `onUnbindMessagingBinding`,
`onSetReaction`, `onOpenPullRequest`). Errors flow up to the same
parent handlers in `App.tsx`.

### State lifecycle risks

None. This is a render-layer refactor — no state changes, no new
persistence, no IPC.

### API surface parity

- `BindingChip` and the reaction-picker invocation move into the new
  flow but expose the same props. `PrChip` keeps its existing
  signature.
- The `ReactionPicker`'s `anchorRef` accepts `HTMLElement | null` —
  works for both `<button>` (today) and `<span>` (after).

### Integration test scenarios

- Click a PR chip → opens PR URL (existing test in
  `apps/desktop/e2e/`).
- Click a binding chip → opens unbind menu (no existing test;
  recommend an E2E spec gets added).
- Click an emoji reaction → toggles it (existing).
- Click add-reaction (smiley) → opens picker (existing).
- Right-click anywhere on the row → opens context menu (the row's
  `onContextMenu` is on the outer `.thread-row-shell` `<div>` and
  fires regardless of which child was hovered).

## Acceptance Criteria

### Functional

- [ ] Every chip on a thread row renders inside a single
  `.thread-row__chips` flex container with `flex-wrap: wrap`.
- [ ] The chip order (left-to-right, then wrapping) is exactly: agent
  type → mode → linked-dir → branch → drift → PR chips → binding
  chips → reactions → add-reaction.
- [ ] Add-reaction is a smiley emoji (`🙂`), not `+`.
- [ ] Add-reaction is the last item in the chip flow when
  `canReact === true`.
- [ ] Clicking a PR chip opens its URL — no thread selection
  side-effect.
- [ ] Clicking a binding chip opens the unbind menu — no thread
  selection side-effect.
- [ ] Clicking a reaction toggles it — no thread selection
  side-effect.
- [ ] Clicking add-reaction opens the picker — no thread selection
  side-effect.
- [ ] Clicking anywhere else on the row selects the thread.
- [ ] Right-clicking the row opens the existing context menu (which
  also lists "Unbind from <platform>" when bindings exist — already
  implemented in PR #187).

### Non-functional

- [ ] No `position: absolute` on any chip group container.
- [ ] No `:has()` selector reserving padding-bottom for any chip
  group.
- [ ] No nested `<button>` elements inside `ThreadRow`. The row
  itself is the only `<button>`; chips are `<span role="button">`.
- [ ] Compact rows (DirectoriesList) wrap chips onto a second line
  when needed; no horizontal scroll, no clipped chips.
- [ ] `prefers-reduced-motion: reduce` continues to disable any
  blink/animation on chip dots.

### Quality gates

- [ ] All existing renderer tests under
  `apps/desktop/src/renderer/src/__tests__/` still pass without
  modification (or with mechanical class-name updates only).
- [ ] No new TypeScript errors.
- [ ] Linting clean (`pnpm lint`).
- [ ] Theme contract test still passes.

## Implementation Phases

The work is small enough to land in a single PR but reviewers will
appreciate the change set being broken into commits.

### Phase A — Refactor chip primitives to spans (no visual change)

- Convert `PrChip` from `<button>` to
  `<span role="button" tabIndex={0}>` with `onClick` + `onKeyDown`
  (Enter/Space). Keep all existing classes and aria-labels.
- Convert `BindingChip`'s outer `<button>` to a span (the menu trigger
  becomes a span). Keep the menu items as real `<button>` elements
  (they live in a portal, not nested).
- Convert reaction `<button>` and add-reaction `<button>` in
  `ThreadRow.tsx` to spans with the same handlers.
- Verify in dev build: clicking each chip type still works.

### Phase B — Collapse to one chip-flow container

- In `ThreadRow.tsx`, replace the four separate chip containers with
  a single `<span class="thread-row__chips">` that contains, in
  order: meta chips, PR chips, binding chips, reaction chips, add-
  reaction chip.
- `ThreadMetaChips` returns its current set of chip spans (no longer
  wrapped in `<span class="thread-row__meta">`) so they can flow as
  siblings inside the new container. Keep its `key`s stable.
- Move binding-chip rendering BACK inside the row's main `<button>`
  (now safe because it's a span not a nested button).
- Add `.thread-row__chips` CSS rule.

### Phase C — Replace `+` add-reaction with smiley emoji

- Swap the literal `+` glyph for `🙂` in `ThreadRow.tsx`.
- Keep the chip's height/padding aligned with other chips so it
  looks like one of them, not a special button.

### Phase D — Delete dead CSS

- Remove `.thread-row__meta`, `.thread-row__pr-chips`,
  `.thread-row__binding-chips`, `.thread-row__reactions`,
  `.thread-row__reaction`, `.thread-row__add-reaction`,
  `.thread-row__reaction-picker-wrap`, the `:has()` padding rule,
  and the absolute-positioning rule.
- Re-verify visual in dev build against the user's design screenshot.

### Phase E — Visual QA + screenshot

- Reload the dev build, exercise:
  - thread with reactions only,
  - thread with PR chips + reactions,
  - thread with binding chips + PR chips + reactions,
  - thread with everything (long branch name forces a wrap).
- Capture before/after screenshots for the PR.

## Alternative Approaches Considered

1. **Keep separate containers, fix layout via grid.** Rejected — same
   coupling problem, just a different way to express it. Each chip
   type still owns its slot; new types still need new rules.

2. **Move all chips outside the main `<button>`, replace the row
   button with a `role="link"` div.** Rejected — selecting the
   thread is fundamentally a button action, not a navigation. The
   `<button>` semantics give us correct keyboard behavior
   (Space/Enter to activate, focus styling) for free. The
   nested-button problem is a child-element problem, not a parent
   problem.

3. **Render every chip as a real `<button>` and absolute-position
   each independently.** This is what we kept doing in piecemeal
   fixes. Rejected — that's what got us into this mess.

## Dependencies & Risks

- **No backend or contract changes.** Pure renderer refactor.
- **Risk: focus styling regression.** Switching from `<button>` to
  `<span role="button">` removes the browser-default focus outline.
  Mitigation: explicit `:focus-visible` rule in CSS that already
  exists for `.tooltip-target`; extend to `.thread-row__chips
  > [role="button"]:focus-visible`.
- **Risk: existing renderer tests query by `getByRole('button',
  ...)`.** Spans with `role="button"` still match `getByRole('button')`
  — verified against testing-library docs. No fixture changes
  expected.
- **Risk: keyboard space-bar scrolling.** When a span with
  `role="button"` is focused, pressing Space should activate it
  (not scroll the page). The `onKeyDown` handler must
  `event.preventDefault()` for Space — same as the existing
  path-copy chips (which already do this).

## Sources & References

### Internal references

- Existing pattern (proven): path-copy chips at
  [ThreadMetaChips.tsx:36](apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx#L36)
- Reactions exemption from no-emoji-as-icon rule:
  [ReactionPicker.tsx:10](apps/desktop/src/renderer/src/features/navigation/ReactionPicker.tsx#L10)
- Recent thrash this plan supersedes: PR
  [#187](https://github.com/pwrdrvr/PwrAgent/pull/187) commits
  `b34d4f5b` (move out of button), `fd37858d` (absolute-position
  back), the original U4.3 commit `e11f5fb3` (introduce binding
  chip).
- Design intent: the user-shared sidebar mockup (2026-05-05),
  showing one chip flow per row with messaging icons next to title
  and chips below in a single wrapping group.

### Parent plan

- [docs/plans/2026-05-04-001-feat-desktop-design-overhaul-plan.md](docs/plans/2026-05-04-001-feat-desktop-design-overhaul-plan.md)
  — Phase 3 (U3.2 reactions, U3.3 PR chips) and Phase 4 (U4.3
  bindings). This plan supersedes the chip-rendering portions of
  those units. The runtime / IPC / persistence portions of U3.2,
  U3.3, U4.3 are unchanged.

### What I am NOT changing

- Reaction picker's contents and ordering.
- PR chip color tokens.
- Messaging binding storage / IPC / unbind menu contents.
- Right-click context menu (the unbind entries added in PR #187 stay).
- The header messaging status indicators (those live in
  `MessagingStatusBar`, not `ThreadRow`).
