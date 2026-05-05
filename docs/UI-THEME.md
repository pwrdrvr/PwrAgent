# PwrAgent UI Theme

This document is the durable source of truth for PwrAgent's visual theme. It pairs with [docs/design/desktop-style-guide.md](design/desktop-style-guide.md): the style guide covers desktop product layout and component behavior, while this document covers the theme thesis, palette, token usage, and visual anti-patterns.

## Theme Thesis

PwrAgent uses a **Tangerine Terminal** theme:

- absolute black app canvas
- near-black structural surfaces
- warm white primary text
- neutral gray secondary text
- sparse tangerine signal
- dense, editorial, operator-tool composition
- restrained motion and minimal elevation

The desired impression is a serious black-first workstation that feels cool enough to work in all day. It should pop through contrast, typography, and precise orange signal, not through decoration.

Avoid gray text on darker gray, generic blue-black Electron dashboard styling, and orange novelty-terminal cosplay.

## Token Contract

The desktop renderer centralizes theme values in [apps/desktop/src/renderer/src/styles/app.css](../apps/desktop/src/renderer/src/styles/app.css). Keep new UI on these semantic tokens instead of adding one-off colors.

```css
--bg-app: #000000;
--bg-sidebar: #050505;
--bg-panel: #0a0a0a;
--bg-panel-elevated: #101010;
--bg-panel-hover: #14110d;
--bg-row-active: #120800;
--bg-input: #080808;

--border-subtle: rgba(247, 243, 235, 0.1);
--border-strong: rgba(247, 243, 235, 0.2);

--text-primary: #f7f3eb;
--text-secondary: #b8b0a5;
--text-muted: #8c857a;

--accent: #ff8a1f;
--accent-strong: #ffa33d;
--accent-bright: #ffb35c;
--accent-soft: rgba(255, 138, 31, 0.12);
--accent-border: rgba(255, 138, 31, 0.42);
--accent-shadow: rgba(255, 138, 31, 0.34);
--focus-ring: var(--accent);
```

Status colors may exist, but they should remain low-volume and functional:

- danger: red-orange text or soft fill for destructive and failed states
- success: muted green for completed or healthy states
- info: desaturated blue for non-primary informational state

Status colors should not compete with tangerine as the main action and focus signal.

### Status indicator dots

For small live-state pips (messaging platform health, per-thread binding
activity, future system-state indicators) use the `--status-*` tokens with
the `.status-dot` utility class:

```css
--status-ok: #5fa969;          /* enabled and healthy */
--status-warning: #d99a3d;     /* needs attention but still working */
--status-suspended: #6b6660;   /* configured but intentionally paused */
--status-error: #c45a3a;       /* configured, attempted, currently failing */
```

Activity (sending or receiving in flight) is signalled by adding the
`.status-dot--blink` modifier — a 1.6s `ease-in-out` opacity pulse. The
animation is suppressed under `prefers-reduced-motion: reduce`.

These dots are subordinate signals: keep them at 8px or smaller, never use
them as the primary call-to-action color, and never use them in body copy.

## Icons

Renderer iconography lives in
[apps/desktop/src/renderer/src/icons/](../apps/desktop/src/renderer/src/icons/).
Every shipped icon should be an exported component from that directory.

- Stroke icons render at 16px square with `strokeWidth: 1.75` and use
  `currentColor` so callers control color via CSS.
- Decorative icons stay `aria-hidden`. Pass `aria-label` only when the icon
  is the *only* signal of meaning (the component flips to `role="img"`
  automatically).
- **No emoji as iconography.** Emoji are content (e.g., user reactions),
  never UI chrome. Folder, branch, worktree, settings, platform marks, etc.
  must come from the icon library.

## Color Rules

Use absolute black as the app foundation. Panels, sidebars, inputs, and message surfaces should be near-black, not gray slabs.

Use warm white for primary labels and content. Use neutral gray for timestamps, helper text, secondary labels, and less important metadata. Do not make the main reading experience gray-on-gray.

Use tangerine for:

- primary action states
- selected and focused controls
- active lens state
- selected thread row cues
- unread cookies
- important command labels and links

Do not use tangerine for:

- body copy
- large background panels
- decorative gradients
- every badge in a row
- generic metadata

The accent should feel like a trading-terminal signal: exact, limited, and useful.

## Typography

Use a restrained desktop typography system:

- primary sans: `Geist`, `IBM Plex Sans`, `SF Pro Text`, `Inter`, `system-ui`, `sans-serif`
- utility mono: `IBM Plex Mono`, `SFMono-Regular`, `SF Mono`, `Consolas`, `monospace`

Rules:

- no viewport-scaled font sizes
- no negative letter spacing
- no oversized utility headings
- use mono for branch names, paths, worktree labels, command-ish labels, and machine state
- keep text dense, scannable, and stable as state changes

## Component Theme Rules

### Shell

The shell is a workstation, not a landing page. Use a fixed left operating rail and a primary work surface. Avoid stacked floating cards on a dark background.

The main app canvas should stay black. Structural separation should come from spacing, typography, subtle borders, and selected-state treatment before shadows or filled panels.

### Sidebar

The sidebar is an information surface. It should read like an active operating queue.

The thread lens switch is:

1. `Inbox`
2. `Recents`
3. `Directories`

`Inbox` is the leftmost lens and shows unread chats. It should use the same visual row language as Recents, not a separate mini-app above the browser.

Do not show a generic Browse header, thread count, or timestamp above the lens switch. Let the rows carry the useful context.

### Thread Rows

Thread rows are one of the main theme carriers. They should be compact, warm, and readable.

Selected rows should use:

- warm active background
- tangerine border or left bar
- stable geometry with no layout shift
- metadata that remains readable without overpowering the title

Unread state uses an orange cookie marker. Do not use a punctuation badge such as `!` for unread.

The secondary "just clicked" or focus highlight must never clip on the left edge, resize the row, or obscure the selected state.

### Lens Switches

Segmented controls should feel crisp and physical. The active segment uses tangerine text or outline. Inactive segments use muted text and near-black surfaces.

State transitions must not ghost the orange outline under another segment. Prefer a direct state update over crossfading borders, backgrounds, or outlines when animation makes the control look wrong.

### Header

Thread detail headers should be compact. Use the thread title as the primary label, then align mode and access pills with it.

Avoid oversized "widget" header areas. Do not show message count or synced-at metadata in the top-right header unless it becomes actionable product context.

### Transcript

Transcript surfaces should stay black-first. Message cards can have subtle near-black backgrounds and tangerine borders when they need focus, but large orange fills should be avoided.

Do not show redundant transcript headers or message-count sublabels above the message list. The panel can keep an accessible label, but the visible surface should start with the transcript content.

Do not put cards inside cards. Do not make the transcript feel like an embedded preview.

### Composer

The reply box is a primary work surface. It can be taller than a standard form input and should feel intentional, with low-contrast chrome until focused.

Controls below the composer should be compact and quiet unless active. The send action may use tangerine, but it should not dominate the screen when disabled or idle.

## Interaction Rules

Motion should help orientation only:

- short hover transitions
- stable selected-state updates
- subtle panel or row changes
- no theatrical page entrances

Hover, focus, selected, loading, and disabled states must not cause layout shift. Fixed-format UI elements need stable dimensions.

Focus states should be visible and tangerine-led, but contained so they do not create clipped halos or stray outlines.

## Tooltips

Two patterns. Pick the right one:

**CSS pseudo-element tooltip** (`tooltip-target` + `data-tooltip` in
`app.css`): cheapest and stateless. Use when the hovered element and
all its ancestors render with `overflow: visible`. The tooltip is an
`::after` pseudo-element positioned absolutely; any clipping ancestor
(`overflow: hidden`, `overflow: auto`, `overflow: scroll`) chops it.

```tsx
<span className="… tooltip-target" data-tooltip={text}>…</span>
```

**Portal-rendered tooltip** (`useViewportTooltip` hook in
`renderer/src/lib/useViewportTooltip.tsx`): when ANY ancestor clips —
sidebar scroll regions, overflow-hidden chips with text-ellipsis,
draggable rails. The hook renders the tooltip via `createPortal` to
`document.body` with `position: fixed`, then clamps to viewport bounds
via `useLayoutEffect` after measuring the rendered text.

```tsx
const { show, hide, tooltipNode } =
  useViewportTooltip({ className: "viewport-tooltip" });
return (
  <span
    onMouseEnter={(e) => show(e.currentTarget, "Multi\nline\ntext")}
    onMouseLeave={hide}
    onFocus={(e) => show(e.currentTarget, "Multi\nline\ntext")}
    onBlur={hide}
  >
    …
    {tooltipNode}
  </span>
);
```

Both honor `\n` for multi-line bodies via `white-space: pre-wrap`.

Anti-pattern: native `title=` attribute. Inconsistent timing across
platforms, can't be styled, no multi-line on macOS Electron.

## Accessibility

Maintain strong contrast between text and surfaces. Critical states should not rely on color alone: pair color with text, shape, placement, iconography, or row treatment.

Long titles, paths, and branch names must truncate or wrap predictably without colliding with timestamps, pills, or controls.

## Anti-Patterns

Avoid:

- gray text on darker gray
- saturated slate, navy, or purple-blue dashboard palettes
- purple accents, gradient orbs, and decorative glows
- orange-dominant panels or orange body copy
- browser-default controls
- oversized headings for utility surfaces
- punctuation unread badges such as `!`
- animated tab states that leave a ghost outline
- cards inside cards
- generic implementation narration in UI copy

## Implementation Checklist

Before shipping a visual change:

- update centralized tokens before adding local color values
- verify the change against this document and the desktop style guide
- check selected, hover, focus, disabled, empty, and unread states
- inspect screenshots at desktop and narrow widths when layout changes
- keep E2E or theme-contract coverage current for shared shell behavior
