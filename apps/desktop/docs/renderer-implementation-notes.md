# Renderer Implementation Notes

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Implementation Notes

- Centralize visual tokens in `styles/app.css` before expanding renderer surfaces.
- **No raw color literals outside `:root` / `:root[data-theme="..."]`.** All
  hex / rgb / hsl / `color-mix(in srgb, #..., ...)` constants belong in the
  token blocks at the top of `styles/app.css`. Use `var(--token)` everywhere
  else. The renderer ships light and dark themes via `data-theme` attribute
  selectors plus a synchronous pre-React bootstrap in `index.html` — any new
  raw color literal in a component rule (or further down in `app.css`) will
  not flip with the theme and is a regression. Derived alpha overlays should
  use `color-mix(in srgb, var(--token) <pct>%, transparent)` so they
  automatically follow the token in every theme.
- **Theme + density source of truth is per-profile `config.toml`
  `[general.appearance]`.** The full path: main process
  `readBootstrapAppearance` (sync TOML read in
  `src/main/settings/appearance-bootstrap.ts`) → BrowserWindow
  `webPreferences.additionalArguments` → preload
  `contextBridge.exposeInMainWorld("__pwragentAppearance", …)` → inline
  `<script>` in `src/renderer/index.html` sets `<html data-theme/data-density>`
  before any React code runs. The renderer's `useAppearance` hook adopts
  the snapshot value when it arrives over IPC and writes changes back via
  `writeSettingsConfig({ general: { appearance: { theme, density } } })`.
  The hook lifts to `App.tsx` and threads the controller down — instantiate
  it once per window so the React state is consistent. Do not reintroduce
  localStorage as a persistence layer; TOML is authoritative across all
  windows and profiles.
- Reuse shell primitives instead of adding one-off page styling.
- When in doubt, make the interface calmer, denser, and more editorial.
- Every tooltip is a portal on `document.body`. A plain-text tooltip is
  `className="tooltip-target"` plus `data-tooltip={text}`:
  [`DataTooltipLayer`](../src/renderer/src/lib/DataTooltipLayer.tsx), mounted
  once in `main.tsx`, draws it for every window. That works inside any
  clipping pane and beside the sidebar. Anything richer (a `ReactNode`, a
  card class, a hover delay, pointer-following placement) uses
  `src/renderer/src/lib/useViewportTooltip.tsx` with the shared
  `.viewport-tooltip` class. Never draw a tooltip with `::after` /
  `content: attr(…)`: a pseudo-element is clipped by its pane and capped by
  its stacking context. The composer's tooltips kept going under the left
  bar until the declarative path moved onto the portal. When a tooltip is
  clipped or buried, fix the layer it renders in. Do not move one
  tooltip's x or raise one control's z-index.
  - **A window shows one plain tooltip at a time.** Every hook instance,
    including the one `DataTooltipLayer` owns, takes a module-level slot on
    `show`, which hides the instance that held it. Without the slot, a hovered
    data-tooltip and a focused surface's tooltip were both on screen.
    `interactive` cards stay out of the slot; `hover-card-bridge.ts` owns them.
  - **Structured hover cards pass their own class instead of
    `.viewport-tooltip`.** The hook takes a `ReactNode`, so a card with
    sections and meters (`.context-usage-card`, `.pr-status-card`) styles
    itself; keep new ones on those two's measurements so the app's hover
    cards stay one family. Plain text tooltips keep `.viewport-tooltip`.
  - **Check the layer your trigger lives in.** The portal renders on
    `document.body`, and `.app-shell` opens no stacking context, so
    full-window layers (Settings at `z-index: 120`) sit in the same root
    stacking context and will paint OVER a tooltip left at the default
    90. Anything reachable from those surfaces needs an explicit higher
    layer — see `.messaging-status-tooltip` and `.pr-status-card`. The
    dedicated Star Map window has the same shape: `.star-map-window`
    opens a stacking context that scopes the card z-scale, so its portal
    tooltips (`.star-map-card__tooltip`) also carry an explicit layer.
  - **An enterable card passes `interactive`.** The sidebar's PR cards
    (`PrChip` `cardActions`) open beside the sidebar and carry Copy URL and
    Detach. `lib/hover-card-bridge.ts` owns them: leaving a chip or its card
    keeps the card for the 300 ms bridge, and entering any chip closes it
    at once and shows the new one without the hover delay, so a sweep across
    chips reads as before. A card that falls back over the rows does not
    bridge. Its buttons stay out of the Tab order and the chip's description;
    the chip keeps Delete and its menu for the keyboard. The card stops React
    propagation of presses, since its portal sits in the row's React tree.
    A card that opens next to its trigger over other hover targets also
    passes `interactive.bridge`: a transparent strip of the card fills the
    10px gap (`tooltipBridgeRect`), so the pointer crosses into the card
    without passing over anything else. The grace period alone is not enough:
    entering another bridged trigger in the gap, such as a project index row
    under the Attention tab, closes the card at once.
  - **A held card ignores layout under it.** While the pointer is in an
    enterable card, or focus is on one of its controls, its anchor moving,
    scrolling or leaving does not close it: the sidebar keeps reflowing
    (a row above gains a Scheduled chip, scroll anchoring compensates), and
    closing on that pulled the card out from under a pointer resting on
    Squash merge. Leaving a card is never instant: for the hover grace
    (`HOVER_TRANSITION_GRACE_MS`) after the pointer leaves, the card still
    counts as held, so a layout move in that window does not close it, and
    the owner's grace (the bridge's, or `dismissAfterGrace`) closes it only
    if the pointer stays out. A pointer that slips out and straight back keeps
    the card even after its anchor moved; once the grace ends, a card whose
    anchor moved closes, pinned or not.
  - **A card read from its trigger follows the trigger.** While keyboard
    focus is on an enterable card's trigger, or the pointer still rests on
    the trigger where it now sits, the same moves re-anchor the card to the
    trigger's new rectangle instead of closing it. "Rests on" is geometric:
    the pointer was last over the trigger, as recorded by document-level
    capture listeners (`mousemove`, `mouseover`, `mouseout`) in
    `useViewportTooltip`, and the trigger's new box still contains that
    point. A trigger that moved out from under a stationary pointer has lost
    it, and one scrolled out of its lane or the viewport has nothing to
    follow. Any other card closes on a move, as a plain tooltip does; plain
    tooltips never follow. `PrChip.held-card.model.test.tsx` states both
    rules.
  - **A card with content worth hearing needs `aria-describedby`.** Point the
    trigger at the hook's `tooltipId` while `visible`; nothing else references
    the portal, so an unwired card is sighted-only. Do not solve this by
    stuffing the data into the trigger's `aria-label` — that changes the
    control's name, not its description.
- Use the project-local [desktop E2E fixture seeding skill](../../../.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) when capturing or refreshing replay-backed desktop E2E fixtures.
